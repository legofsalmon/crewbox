import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { hasSeaAsset, seaAsset } from './box.ts'

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
export const hasEmbeddedLiveKit = (): boolean => hasSeaAsset(`livekit/${assetName()}`)

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
async function waitForPort(
  port: number,
  timeoutMs: number,
  /** Give up early — the child is already gone and nothing will open it. */
  abandoned: () => boolean = () => false
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (abandoned()) return false
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
/**
 * Remove the pid file, whatever is actually there.
 *
 * Recursive and swallowing, because every caller is already handling a
 * failure or inside an event handler: a tidy-up that throws would replace a
 * reported problem with an unreported one, and from `child.on('exit')` it
 * would be an uncaught exception with nothing above it — the box, for a
 * stale file. Whatever will not go is clutter, and the next start tries
 * again.
 */
function tidyPidFile(pidPath: string): void {
  try {
    rmSync(pidPath, { force: true, recursive: true })
  } catch {
    // Locked, or not ours.
  }
}

/**
 * Is the pid in the file still the SFU, or has the number been handed on?
 *
 * Pids are recycled, and a box that has just had its power cut and come back
 * up is precisely where they get recycled from a low number: the pid file
 * records 812, the machine reboots, and 812 is now `wpa_supplicant`, or
 * `dnsmasq`, or the thing serving the crew's Wi-Fi. `process.kill(812)` is
 * then a box that boots and shoots something on the rig, once, silently, and
 * blames a stale voice file.
 *
 * Linux answers this exactly: `/proc/<pid>/exe` is a link to the running
 * binary and `/proc/<pid>/cmdline` is its argv, and the SFU we unpacked is
 * named in one or the other. Only a box with no `/proc` — a mac, a stripped
 * container — comes back `unknown`, and there the caller keeps the old
 * behaviour rather than never reaping, because a held :7880 is the fault
 * this whole function exists for.
 */
export function sfuIdentity(pid: number, binPath: string): 'ours' | 'someone-elses' | 'unknown' {
  // Through symlinks, because /proc reports the resolved path and a data
  // directory under /var on a mac is really /private/var.
  let real = binPath
  try {
    real = realpathSync(binPath)
  } catch {
    // Unpacked by a build that has since been replaced. The string still
    // matches what was spawned, which is what the comparison is for.
  }
  const isOurs = (path: string) => path === binPath || path === real

  let exe: string | null = null
  try {
    // A binary replaced under a running process reads back as `<path>
    // (deleted)` — still that path, and the most likely way to meet it is an
    // update that swapped the file.
    exe = readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '')
  } catch {
    // Someone else's process (readable only by its owner or root), a pid
    // that has gone, or no /proc at all. The next two reads say which.
  }
  if (exe && isOurs(exe)) return 'ours'

  // A script runs under its interpreter, so `exe` names node rather than the
  // SFU. argv still names what was started, and is world-readable.
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    return argv.some(isOurs) ? 'ours' : 'someone-elses'
  } catch {
    // Gone, or nothing to read.
  }
  if (exe) return 'someone-elses'
  try {
    readlinkSync('/proc/self/exe')
  } catch {
    return 'unknown'
  }
  return 'someone-elses'
}

export async function reapOrphanLiveKit(
  dir: string,
  log: BoxLog,
  /** Another crewbox already running, if there is one. */
  owner: number | null = null,
  /** The SFU binary, when it is not the one unpacked into `dir`. */
  binPath: string = join(dir, assetName())
): Promise<boolean> {
  const pidPath = join(dir, PID_FILE)
  let pid: number
  try {
    pid = Number(readFileSync(pidPath, 'utf8').trim())
  } catch {
    return false
  }
  // A zero-byte or unparseable file is a record of nothing — most likely a
  // write that ran out of disk halfway. Leaving it would make every future
  // start skip the reap, so it goes.
  if (!Number.isInteger(pid) || pid <= 0) {
    tidyPidFile(pidPath)
    return false
  }

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

  // Alive is not the same as ours. See `sfuIdentity`.
  const identity = sfuIdentity(pid, binPath)
  if (identity === 'someone-elses') {
    log.warn(
      `voice: pid ${pid} in the voice status file belongs to something else now — ` +
        'leaving it alone and forgetting the file'
    )
    tidyPidFile(pidPath)
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
  //
  // Guarded, because this is the one write on the boot path that is always a
  // *new* file — which is exactly what fails first on a full disk. Unguarded
  // it threw out of `main()` and exited 1 with the SFU already spawned, and
  // the child outlived the box holding :7880 for good: the next boot's reaper
  // reads a zero-byte file, gets NaN, and skips it. So the child goes with us
  // rather than being orphaned, and voice simply stays off.
  // Beside the config, not beside the binary. They are the same directory
  // for an SFU this box unpacked, and very much not for one the operator
  // installed: `dirname(binPath)` there is /usr/local/bin, which is where
  // the pid file would have been written — if it were writable at all, and
  // if it were, nowhere the reaper looks.
  const pidPath = join(dirname(configPath), PID_FILE)
  if (child.pid) {
    try {
      writeFileSync(pidPath, String(child.pid))
    } catch (error) {
      child.kill('SIGKILL')
      tidyPidFile(pidPath)
      log.warn(`voice: could not record the SFU's pid (${String(error)}); voice stays off`)
      return { sfu: null, failure: 'no-start' }
    }
  }

  let exited = false
  /**
   * Why the child never ran, when the OS said.
   *
   * `child.on('error')` carries the code, the syscall and the path — EACCES
   * on a binary without the exec bit, ENOEXEC for the wrong architecture,
   * ENOENT for a `CREWBOX_LIVEKIT_BIN` that is not there. It was thrown
   * away, and the warning said only "did not start listening", which is
   * both the least useful thing to say and not what happened.
   */
  let spawnError: Error | null = null
  child.on('error', (err) => {
    exited = true
    spawnError = err
  })
  child.on('exit', (code) => {
    exited = true
    tidyPidFile(pidPath)
    if (code !== 0 && code !== null) log.warn(`voice: SFU exited with code ${code}`)
  })
  // The SFU's own logging goes to the box log so a failure is diagnosable.
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim()
    if (line) log.warn(`livekit: ${line}`)
  })

  // Stops as soon as the child is gone rather than sitting out the full
  // eight seconds: a binary that cannot execute fails in milliseconds, and
  // the box was waiting anyway before saying so.
  const up = await waitForPort(LIVEKIT_PORT, 8000, () => exited)
  if (!up) {
    child.kill()
    const why: Error | null = spawnError
    log.warn(
      why
        ? `voice: could not start the SFU (${String(why)}); voice stays off`
        : 'voice: SFU did not start listening; voice stays off'
    )
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
        // The pid file goes here, synchronously, rather than in the exit
        // handler: `stop()` used to resolve after a fixed 500 ms whether or
        // not the child had gone, and the caller exits straight after — so
        // on a normal shutdown the handler often never ran and every box
        // left a stale pid behind for the next boot to reason about.
        tidyPidFile(pidPath)
        if (exited) return
        child.kill('SIGTERM')
        // Waited for, not slept through: it takes a moment to close rooms,
        // and returning while it is still holding :7880 hands the next
        // start a port that is not free.
        const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        const deadline = new Promise<void>((resolve) => setTimeout(resolve, 3000))
        await Promise.race([gone, deadline])
        if (!exited) {
          child.kill('SIGKILL')
          await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 500))])
        }
      },
    },
  }
}

/**
 * An SFU binary this box can run that is not inside it.
 *
 * The packaged box carries its own; a rig installed from source and run by
 * systemd does not, and the unit file shipped alongside pointed
 * `LIVEKIT_URL` at an example host with the dev credentials. So the rack
 * box told every phone voice was available and minted tokens for an SFU
 * that did not exist — the runbook, meanwhile, said the SFU runs inside the
 * box and starts and stops with it, which was true of one deployment and
 * not the other.
 *
 * `CREWBOX_LIVEKIT_BIN` closes that: point it at a livekit-server on the
 * machine and the box supervises it exactly as it supervises its own —
 * same config, same port, same proxy behind the box's certificate, same
 * orphan reaping — so the runbook's sentence is true of a rack too.
 */
export const externalLiveKit = (): string | null => {
  const configured = process.env.CREWBOX_LIVEKIT_BIN?.trim()
  return configured ? configured : null
}

/** Whether this process can run an SFU at all — embedded or on disk. */
export const canRunLiveKit = (): boolean => hasEmbeddedLiveKit() || externalLiveKit() !== null

/**
 * Extract and start the SFU. Returns null when there is no binary to run,
 * or when it failed to come up — the caller treats both the same way and
 * simply leaves voice off.
 */
export async function startEmbeddedLiveKit(options: StartLiveKitOptions): Promise<SpawnOutcome> {
  const asset = seaAsset(`livekit/${assetName()}`)
  const external = asset ? null : externalLiveKit()
  // No failure recorded: a build without the binary and no binary named on
  // disk is a deployment without voice, not a fault — the readiness copy for
  // that case already exists.
  if (!asset && !external) return { sfu: null }

  // Before anything else. A box that was killed rather than stopped leaves
  // its SFU running, and that orphan is *executing the very file* the unpack
  // below overwrites — on Linux you cannot write to a running executable, so
  // unpacking first fails with ETXTBSY and voice stays off for good. Clearing
  // it first also frees the port, which the orphan would otherwise hold while
  // answering with the previous run's keys.
  //
  // The binary is named explicitly because the reaper checks that the pid it
  // is about to signal really is the SFU, and an external one lives wherever
  // the operator put it rather than in the data directory.
  const dir = join(options.dataDir, 'livekit')
  await reapOrphanLiveKit(dir, options.log, options.owner ?? null, external ?? undefined)

  let unpacked: { binPath: string; configPath: string }
  try {
    unpacked = external
      ? { binPath: external, configPath: writeLiveKitConfig(options) }
      : unpackLiveKit(options.dataDir, asset!, options.key, options.secret, options.iface)
  } catch (error) {
    options.log.warn(`voice: could not prepare the SFU (${String(error)}); voice stays off`)
    return { sfu: null, failure: 'no-start' }
  }
  if (external) options.log.info(`voice: supervising the SFU at ${external}`)
  return spawnLiveKit(unpacked.binPath, unpacked.configPath, options, options.log)
}

/**
 * The config for an SFU whose binary this box did not unpack.
 *
 * Written into the same directory the embedded one uses, so the pid file
 * lands beside it and everything downstream — the reaper, the proxy, the
 * readiness copy — reads exactly one place.
 */
function writeLiveKitConfig(options: StartLiveKitOptions): string {
  const dir = join(options.dataDir, 'livekit')
  const configPath = join(dir, 'livekit.yaml')
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath, livekitConfigYaml(options.key, options.secret, options.iface))
  return configPath
}
