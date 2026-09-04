import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { seaAsset } from './box.ts'

/**
 * The box runs its own LiveKit SFU.
 *
 * Voice used to be the one thing that made the single-file box a lesser
 * product: it needed a second server the admin had to find, install and
 * configure, so in practice almost nobody had it. The SFU binary now rides
 * inside the box the same way the web bundle does — extracted on first boot,
 * started as a child process, stopped when the box stops.
 *
 * Everything here is optional and fails soft. A build without the embedded
 * binary, or a machine where it won't run, leaves voice exactly as it was:
 * off, with the button absent rather than broken.
 */

/** Single UDP port rather than a range — one hole for a venue firewall, not ten thousand. */
export const LIVEKIT_PORT = 7880
const LIVEKIT_TCP_PORT = 7881
const LIVEKIT_UDP_PORT = 7882

const assetName = () => (process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server')
/** Records the running SFU so a later boot can clear one this box orphaned. */
const PID_FILE = 'livekit.pid'

/** Whether this build carries an SFU it can run. */
export const hasEmbeddedLiveKit = (): boolean => seaAsset(`livekit/${assetName()}`) !== null

export interface EmbeddedLiveKit {
  port: number
  key: string
  secret: string
  stop: () => Promise<void>
}

/**
 * Why the embedded SFU is not running, when that can be said.
 *
 * `port-held` is the one worth a name of its own: something else is
 * listening on the SFU's port, so this box's own SFU cannot bind and
 * whatever *is* there will reject this box's tokens. Found the hard way — a
 * `livekit-server` left behind by an old test session held 7880 for a day,
 * and every layer above reported voice as fine while every join died.
 */
export type SfuFailure = 'port-held' | 'no-start'

export interface SpawnOutcome {
  sfu: EmbeddedLiveKit | null
  failure?: SfuFailure
}

/** What a live SFU probe found. Facts, not inferences — see `probeSfu`. */
export type SfuProbeResult = 'ok' | 'rejected' | 'unreachable'

/**
 * Ask whatever is on the SFU port whether it accepts this box's tokens.
 *
 * `waitForPort` proves only that *something* is listening, and that is not
 * the question. The failure this exists for: a stray SFU (an orphan from
 * another data directory, or a process someone started by hand) holds the
 * port, this box's own SFU dies of EADDRINUSE, the port check sees the
 * stranger and reports success — and then every token this box mints is
 * rejected by a process holding different keys. Voice looks configured
 * everywhere and works nowhere.
 *
 * So: mint a real token and call the SFU's own validate endpoint — the same
 * `/rtc/validate` the browser SDK calls before opening its socket. Only a
 * LiveKit holding this box's key can answer 200 to that.
 *
 * - `ok`          — it accepted the token. It is ours and healthy.
 * - `rejected`    — something answered and did not accept it. Almost always
 *                   the stranger-on-the-port case above.
 * - `unreachable` — nothing answered.
 */
export async function probeSfu(
  port: number,
  key: string,
  secret: string,
  timeoutMs = 1500
): Promise<SfuProbeResult> {
  let token: string
  try {
    // Dynamic, matching app.ts: keeps the SDK off the --stop/--status path.
    const { AccessToken } = await import('livekit-server-sdk')
    const at = new AccessToken(key, secret, { identity: 'crewbox-health', ttl: '60s' })
    // The same grant shape a real join carries; validate checks for it.
    at.addGrant({ room: 'crewbox-health-probe', roomJoin: true })
    token = await at.toJwt()
  } catch {
    // Could not even mint a token — nothing useful to say about the SFU.
    return 'unreachable'
  }

  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/rtc/validate?access_token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(timeoutMs) }
    )
    return res.ok ? 'ok' : 'rejected'
  } catch (error) {
    // A connection that was refused outright is nothing listening. Anything
    // else — a reset, garbage instead of HTTP — is something listening that
    // is not usable, which is the `rejected` story with a different accent.
    const code = (error as { cause?: { code?: string } })?.cause?.code
    if (code === 'ECONNREFUSED') return 'unreachable'
    if (error instanceof Error && error.name === 'TimeoutError') return 'unreachable'
    return 'rejected'
  }
}

/**
 * API credentials for the embedded SFU. Generated once per box and kept, so
 * tokens minted before a restart stay valid after it.
 */
export function livekitCredentials(
  getSetting: (key: string) => string | undefined,
  setSetting: (key: string, value: string) => void
): { key: string; secret: string } {
  let key = getSetting('livekitKey')
  let secret = getSetting('livekitSecret')
  if (!key || !secret) {
    key = `box${randomBytes(6).toString('hex')}`
    secret = randomBytes(32).toString('base64url')
    setSetting('livekitKey', key)
    setSetting('livekitSecret', secret)
  }
  return { key, secret }
}

/** Resolves once something is listening, or false if it never comes up. */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      const done = (result: boolean) => {
        socket.destroy()
        resolve(result)
      }
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
      socket.setTimeout(500, () => done(false))
    })
    if (open) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

export interface BoxLog {
  info: (msg: string) => void
  warn: (msg: string) => void
}

export interface StartLiveKitOptions {
  dataDir: string
  key: string
  secret: string
  /**
   * Crew-facing adapter IP (CREWBOX_IFACE), when one is pinned and present.
   * The SFU's signalling then binds to it plus loopback instead of every
   * adapter, keeping the voice server from answering on the lighting VLAN.
   * Loopback stays in the list because the box's own proxy and health probe
   * reach the SFU at 127.0.0.1.
   */
  iface?: string
  /**
   * Another crewbox already running, when there is one — see
   * `reapOrphanLiveKit`, which will not touch that box's SFU.
   */
  owner?: number | null
  log: BoxLog
}

/**
 * The SFU config. Written as a file rather than passed as flags so a stuck
 * box can be diagnosed by reading it.
 *
 * use_external_ip stays off: this SFU serves a LAN with no route to the
 * internet, and STUN lookups against a dead uplink only add startup latency.
 */
export const livekitConfigYaml = (key: string, secret: string, iface = ''): string =>
  [
    `port: ${LIVEKIT_PORT}`,
    // Media (rtc.*) binds every adapter regardless — it only ever speaks to
    // connected peers. This list is the signalling HTTP/WS surface.
    iface ? `bind_addresses: ["127.0.0.1", "${iface}"]` : `bind_addresses: ["0.0.0.0"]`,
    `rtc:`,
    `  tcp_port: ${LIVEKIT_TCP_PORT}`,
    `  udp_port: ${LIVEKIT_UDP_PORT}`,
    `  use_external_ip: false`,
    `keys:`,
    `  ${key}: ${secret}`,
    `logging:`,
    `  level: warn`,
    '',
  ].join('\n')

/**
 * Write the SFU and its config to disk. Split out from the spawn so the
 * supervisor can be tested against a stub binary — the real SFU is only
 * present in a release build, and this is the code that decides whether a
 * crew has voice on site.
 */
export function unpackLiveKit(
  dataDir: string,
  binary: ArrayBuffer | Buffer,
  key: string,
  secret: string,
  iface = ''
): { binPath: string; configPath: string } {
  const dir = join(dataDir, 'livekit')
  const binPath = join(dir, assetName())
  const configPath = join(dir, 'livekit.yaml')
  mkdirSync(dir, { recursive: true })
  writeFileSync(binPath, Buffer.from(binary as ArrayBuffer))
  if (process.platform !== 'win32') chmodSync(binPath, 0o755)
  writeFileSync(configPath, livekitConfigYaml(key, secret, iface))
  return { binPath, configPath }
}

/**
 * Kill an SFU left behind by a previous run, and wait for its port to free.
 *
 * The box stops its SFU on SIGTERM and SIGINT, but not when it is killed
 * outright — and being force-quit is a supported way to stop a box, since the
 * store is SQLite in WAL mode and the whole product assumes hard power cuts.
 * The orphan keeps holding 7880, which is worse than it sounds: the next box
 * spawns its own SFU, that one dies of EADDRINUSE, and waitForPort sees the
 * orphan still listening and reports success. Voice then looks fine and is
 * served by a process holding the previous run's keys, so tokens minted by
 * the new box are rejected and nobody can talk.
 *
 * **Only when nothing else is running the box.** The pid file says which
 * process owns 7880, not whether that owner is finished with it, and there is
 * one moment when it is very much not: an update launches a new box while the
 * old one is alive, supervising, and able to put itself back. Reaping there
 * kills the *supervisor's* SFU, so a rollback returned a box that kept
 * minting tokens for a process this one had killed and every voice join
 * failed until somebody restarted it by hand. A box started by hand beside
 * another is the same picture with a shorter story. So a live owner means
 * leave it alone; a force-quit box leaves a status file whose pid is dead,
 * which is exactly the case this function is for.
 *
 * Returns true if it reaped something, so the caller can say so.
 */
export async function reapOrphanLiveKit(
  dir: string,
  log: BoxLog,
  /** Another crewbox already running, if there is one. */
  owner: number | null = null
): Promise<boolean> {
  const pidPath = join(dir, PID_FILE)
  let pid: number
  try {
    pid = Number(readFileSync(pidPath, 'utf8').trim())
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false

  const alive = (): boolean => {
    try {
      // Signal 0 tests for existence without touching the process.
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  // Before the owner check, so a stale file is always tidied: the update path
  // stops its own SFU on the way out, which leaves exactly this — a live box
  // and a pid that is already gone.
  if (!alive()) {
    rmSync(pidPath, { force: true })
    return false
  }
  if (owner !== null) {
    log.warn(`voice: an SFU is running (pid ${pid}) and box ${owner} still has it — leaving it`)
    return false
  }

  log.warn(`voice: an SFU from a previous run is still running (pid ${pid}) — stopping it`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Gone between the check and the signal, or not ours to kill.
  }

  // Wait for it to actually go rather than guessing at a delay: it takes a
  // moment to close rooms, and returning early would hand the next spawn a
  // port that is still held and an executable still in use.
  const deadline = Date.now() + 5000
  while (alive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (alive()) {
    log.warn(`voice: SFU ${pid} ignored SIGTERM; killing it`)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Raced us, or not ours.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  rmSync(pidPath, { force: true })
  return true
}

/**
 * Start an already-unpacked SFU and prove it is the one answering. The
 * caller leaves voice off on any failure; `failure` says which kind, so the
 * admin panel can tell someone what to actually do about it.
 */
export async function spawnLiveKit(
  binPath: string,
  configPath: string,
  creds: { key: string; secret: string },
  log: BoxLog
): Promise<SpawnOutcome> {
  let child: ChildProcess
  try {
    child = spawn(binPath, ['--config', configPath], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    log.warn(`voice: could not start the SFU (${String(error)}); voice stays off`)
    return { sfu: null, failure: 'no-start' }
  }

  // Recorded before the wait, so a box killed mid-startup still leaves a
  // trail for the next one to clean up.
  const pidPath = join(dirname(binPath), PID_FILE)
  if (child.pid) writeFileSync(pidPath, String(child.pid))

  let exited = false
  child.on('error', () => {
    exited = true
  })
  child.on('exit', (code) => {
    exited = true
    rmSync(pidPath, { force: true })
    if (code !== 0 && code !== null) log.warn(`voice: SFU exited with code ${code}`)
  })
  // The SFU's own logging goes to the box log so a failure is diagnosable.
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim()
    if (line) log.warn(`livekit: ${line}`)
  })

  const up = await waitForPort(LIVEKIT_PORT, 8000)
  if (!up) {
    child.kill()
    log.warn('voice: SFU did not start listening; voice stays off')
    return { sfu: null, failure: 'no-start' }
  }
  if (exited) {
    // The port is listening and our child is dead: the EADDRINUSE signature.
    // Whatever is on the port is not ours and will reject our tokens.
    log.warn(
      `voice: something else is already holding :${LIVEKIT_PORT}; voice stays off — ` +
        `find it with: lsof -nP -iTCP:${LIVEKIT_PORT} -sTCP:LISTEN`
    )
    return { sfu: null, failure: 'port-held' }
  }

  // The port being open is not the same thing as our SFU being behind it.
  // The race this closes: a stranger already holds the port, our child dies
  // of EADDRINUSE a few milliseconds *after* waitForPort saw the stranger
  // listening — `exited` is still false, and without this check the box
  // reports voice up while every token it mints gets rejected. Ask the
  // listener to validate one of our tokens; only our SFU can.
  const probe = await probeSfu(LIVEKIT_PORT, creds.key, creds.secret, 4000)
  if (probe !== 'ok') {
    child.kill()
    log.warn(
      probe === 'rejected'
        ? `voice: the process on :${LIVEKIT_PORT} rejects this box's tokens (not our SFU?); ` +
            `voice stays off — find it with: lsof -nP -iTCP:${LIVEKIT_PORT} -sTCP:LISTEN`
        : 'voice: SFU listening but not answering; voice stays off'
    )
    return { sfu: null, failure: probe === 'rejected' ? 'port-held' : 'no-start' }
  }

  log.info(`voice: SFU running on :${LIVEKIT_PORT} and accepting this box's tokens`)

  return {
    sfu: {
      port: LIVEKIT_PORT,
      key: creds.key,
      secret: creds.secret,
      stop: async () => {
        if (exited) return
        child.kill('SIGTERM')
        // Give it a moment to close rooms cleanly, then insist.
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (!exited) child.kill('SIGKILL')
      },
    },
  }
}

/**
 * Extract and start the embedded SFU. Returns null when this build has no
 * binary, or when it failed to come up — the caller treats both the same way
 * and simply leaves voice off.
 */
export async function startEmbeddedLiveKit(options: StartLiveKitOptions): Promise<SpawnOutcome> {
  const asset = seaAsset(`livekit/${assetName()}`)
  // No failure recorded: a build without the binary is a build without
  // voice, not a fault — the readiness copy for that case already exists.
  if (!asset) return { sfu: null }

  // Before anything else. A box that was killed rather than stopped leaves
  // its SFU running, and that orphan is *executing the very file* the unpack
  // below overwrites — on Linux you cannot write to a running executable, so
  // unpacking first fails with ETXTBSY and voice stays off for good. Clearing
  // it first also frees the port, which the orphan would otherwise hold while
  // answering with the previous run's keys.
  await reapOrphanLiveKit(join(options.dataDir, 'livekit'), options.log, options.owner ?? null)

  let unpacked: { binPath: string; configPath: string }
  try {
    unpacked = unpackLiveKit(options.dataDir, asset, options.key, options.secret, options.iface)
  } catch (error) {
    options.log.warn(`voice: could not unpack the SFU (${String(error)}); voice stays off`)
    return { sfu: null, failure: 'no-start' }
  }
  return spawnLiveKit(unpacked.binPath, unpacked.configPath, options, options.log)
}
