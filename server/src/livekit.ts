import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
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

/** Whether this build carries an SFU it can run. */
export const hasEmbeddedLiveKit = (): boolean => seaAsset(`livekit/${assetName()}`) !== null

export interface EmbeddedLiveKit {
  port: number
  key: string
  secret: string
  stop: () => Promise<void>
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
  log: BoxLog
}

/**
 * The SFU config. Written as a file rather than passed as flags so a stuck
 * box can be diagnosed by reading it.
 *
 * use_external_ip stays off: this SFU serves a LAN with no route to the
 * internet, and STUN lookups against a dead uplink only add startup latency.
 */
export const livekitConfigYaml = (key: string, secret: string): string =>
  [
    `port: ${LIVEKIT_PORT}`,
    `bind_addresses: ["0.0.0.0"]`,
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
  secret: string
): { binPath: string; configPath: string } {
  const dir = join(dataDir, 'livekit')
  const binPath = join(dir, assetName())
  const configPath = join(dir, 'livekit.yaml')
  mkdirSync(dir, { recursive: true })
  writeFileSync(binPath, Buffer.from(binary as ArrayBuffer))
  if (process.platform !== 'win32') chmodSync(binPath, 0o755)
  writeFileSync(configPath, livekitConfigYaml(key, secret))
  return { binPath, configPath }
}

/**
 * Start an already-unpacked SFU and wait for it to listen. Returns null if it
 * won't run or never comes up; the caller leaves voice off either way.
 */
export async function spawnLiveKit(
  binPath: string,
  configPath: string,
  creds: { key: string; secret: string },
  log: BoxLog
): Promise<EmbeddedLiveKit | null> {
  let child: ChildProcess
  try {
    child = spawn(binPath, ['--config', configPath], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    log.warn(`voice: could not start the SFU (${String(error)}); voice stays off`)
    return null
  }

  let exited = false
  child.on('error', () => {
    exited = true
  })
  child.on('exit', (code) => {
    exited = true
    if (code !== 0 && code !== null) log.warn(`voice: SFU exited with code ${code}`)
  })
  // The SFU's own logging goes to the box log so a failure is diagnosable.
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim()
    if (line) log.warn(`livekit: ${line}`)
  })

  const up = await waitForPort(LIVEKIT_PORT, 8000)
  if (!up || exited) {
    child.kill()
    log.warn('voice: SFU did not start listening; voice stays off')
    return null
  }

  log.info(`voice: SFU running on :${LIVEKIT_PORT}`)

  return {
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
  }
}

/**
 * Extract and start the embedded SFU. Returns null when this build has no
 * binary, or when it failed to come up — the caller treats both the same way
 * and simply leaves voice off.
 */
export async function startEmbeddedLiveKit(
  options: StartLiveKitOptions
): Promise<EmbeddedLiveKit | null> {
  const asset = seaAsset(`livekit/${assetName()}`)
  if (!asset) return null

  let unpacked: { binPath: string; configPath: string }
  try {
    unpacked = unpackLiveKit(options.dataDir, asset, options.key, options.secret)
  } catch (error) {
    options.log.warn(`voice: could not unpack the SFU (${String(error)}); voice stays off`)
    return null
  }
  return spawnLiveKit(unpacked.binPath, unpacked.configPath, options, options.log)
}
