import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Single-binary "box" support. scripts/build-box.mjs packages the server and
 * the built web app into one Node Single Executable Application — download,
 * double-click, scan the QR. At runtime the embedded web bundle is extracted
 * under the data directory so @fastify/static and the SPA fallback work
 * unchanged. Everything here is inert under plain Node (dev, systemd).
 */

interface SeaApi {
  isSea(): boolean
  getAsset(key: string, encoding?: 'utf8'): ArrayBuffer | string
}

// The SEA bundle is CJS (require exists); under tsx/ESM this resolves null.
declare const require: ((id: string) => unknown) | undefined

function seaApi(): SeaApi | null {
  try {
    if (typeof require !== 'function') return null
    const sea = require('node:sea') as SeaApi
    return sea.isSea() ? sea : null
  } catch {
    return null
  }
}

/** True when running as the packaged single-file box binary. */
export function isBox(): boolean {
  return seaApi() !== null
}

/** Box data lives with the user, not wherever the binary was launched from. */
export function boxDataDir(): string {
  return join(homedir(), '.crewbox', 'data')
}

/**
 * An embedded asset, or null when this build doesn't carry it. Assets are
 * optional by design: a box built without the LiveKit binary is still a
 * complete box, it just can't run voice itself.
 */
export function seaAsset(key: string): ArrayBuffer | null {
  const sea = seaApi()
  if (!sea) return null
  try {
    return sea.getAsset(key) as ArrayBuffer
  } catch {
    return null
  }
}

/** Extract the embedded web bundle under dataDir; returns the dist path. */
export function extractWebDist(dataDir: string): string {
  const sea = seaApi()
  if (!sea) throw new Error('extractWebDist called outside the box binary')
  const manifest = JSON.parse(sea.getAsset('dist-manifest.json', 'utf8') as string) as string[]
  const root = join(dataDir, 'web-dist')
  for (const rel of manifest) {
    const target = join(root, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, Buffer.from(sea.getAsset(`dist/${rel}`) as ArrayBuffer))
  }
  return root
}

/** Reachable LAN URLs for the crew (non-internal IPv4s). */
export function lanUrls(port: number, secure = false): string[] {
  const urls: string[] = []
  const scheme = secure ? 'https' : 'http'
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) urls.push(`${scheme}://${addr.address}:${port}`)
    }
  }
  return urls
}

/** What the menu-bar and tray helpers need to draw their menu. */
export interface BoxStatus {
  pid: number
  port: number
  secure: boolean
  joinUrl: string
  urls: string[]
  eventPin: string
  eventName: string
  version: string
}

/** Where the helpers look. Under the data dir so it travels with the box. */
export function statusPath(dataDir: string): string {
  return join(dataDir, 'box-status.json')
}

/**
 * Publish what the box is, for the menu-bar (macOS) and tray (Windows)
 * helpers to read.
 *
 * A file rather than an HTTP call because of what the helper is for: it has
 * to be able to say "not running" and offer Quit even when the server is
 * wedged and answering nothing. It also means the helpers need no HTTP
 * client, no auth, and no knowledge of which port the box chose.
 *
 * The pid is the point of the whole thing. A double-clicked .app has no
 * terminal and — being a plain console binary with no AppKit — no Dock icon
 * either, so before this there was genuinely no way to stop a running box
 * short of Activity Monitor.
 */
export function writeBoxStatus(dataDir: string, status: BoxStatus): void {
  try {
    // No mkdir: startup already created the data directory, and creating one
    // here would mean this call can block on a filesystem rather than just
    // write a small file.
    writeFileSync(statusPath(dataDir), JSON.stringify(status, null, 2))
  } catch {
    // Never block startup on this. A box that runs without a menu is the
    // situation we were already in; a box that won't start is worse.
  }
}

/** Remove the status file on a clean exit, so the helper stops claiming a
 *  box is running. A hard power cut leaves it behind — the helper treats a
 *  stale pid as "not running" rather than trusting the file. */
export function clearBoxStatus(dataDir: string): void {
  try {
    rmSync(statusPath(dataDir), { force: true })
  } catch {
    /* tidying up must never fail a shutdown */
  }
}

/** Read a published status, or null when no box is running.
 *
 * The pid is checked rather than trusted: a hard power cut leaves the file
 * behind, and reporting a dead box as running is worse than reporting
 * nothing, because the only reason anyone asks is to find out the truth. */
export function readBoxStatus(dataDir: string): BoxStatus | null {
  try {
    const status = JSON.parse(readFileSync(statusPath(dataDir), 'utf8')) as BoxStatus
    if (!status?.pid) return null
    try {
      // Signal 0 tests for existence without delivering anything. EPERM means
      // it exists but belongs to someone else, which still counts as running.
      process.kill(status.pid, 0)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') return null
    }
    return status
  } catch {
    return null
  }
}

/**
 * `crewbox --stop`: SIGTERM whatever box is running, and wait for it to go.
 *
 * The universal answer to "how do I stop this", and on Linux the *only* one
 * that works everywhere — a headless box in a shed has no tray to click, and
 * tray support across Linux desktops is too uneven to rely on.
 *
 * Returns a process exit code.
 */
export async function stopRunningBox(dataDir: string): Promise<number> {
  const status = readBoxStatus(dataDir)
  if (!status) {
    console.log('No box is running.')
    return 0
  }
  const label = status.eventName || 'Crewbox'
  try {
    process.kill(status.pid, 'SIGTERM')
  } catch (err) {
    console.error(`Could not stop ${label} (pid ${status.pid}): ${String(err)}`)
    // EPERM here means another user started it — worth saying so, because
    // "permission denied" on your own machine is otherwise baffling.
    return 1
  }
  // Wait rather than returning optimistically: the caller's next move is
  // usually to replace the binary, and on Windows that fails while the old
  // process still holds it.
  for (let i = 0; i < 100; i++) {
    if (!readBoxStatus(dataDir)) {
      console.log(`Stopped ${label}.`)
      return 0
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.error(`${label} (pid ${status.pid}) did not stop within 10s.`)
  return 1
}

/** `crewbox --status`: say whether a box is running, and where. */
export function printBoxStatus(dataDir: string): number {
  const status = readBoxStatus(dataDir)
  if (!status) {
    console.log('No box is running.')
    return 1
  }
  console.log(`${status.eventName || 'Crewbox'} is running (pid ${status.pid})`)
  console.log(`  Join:      ${status.joinUrl}`)
  for (const url of status.urls.slice(1)) console.log(`             ${url}`)
  console.log(`  Event PIN: ${status.eventPin}`)
  console.log(`  Stop it:   ${process.argv[0]} --stop`)
  return 0
}

/** Best-effort browser open (double-click UX); silent when headless. */
export function openBrowser(url: string): void {
  if (process.env.CREWBOX_NO_OPEN) return
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref()
  } catch {
    // No display or no opener — the terminal banner covers it.
  }
}

/** Terminal banner with join URL, PIN, and a scannable QR (TTY only). */
export function printBoxBanner(
  port: number,
  eventPin: string,
  secure = false,
  { eventName = '', firstRun = false }: { eventName?: string; firstRun?: boolean } = {}
): void {
  const urls = lanUrls(port, secure)
  const joinUrl = urls[0] ?? `${secure ? 'https' : 'http'}://localhost:${port}`
  const lines = [
    '',
    '  ┌─────────────────────────────────────────────┐',
    `    ${eventName || 'Crewbox'} is running`,
    '',
    ...(firstRun
      ? // A browser is opening on this too, but headless boxes (systemd, a
        // laptop over SSH) only get the terminal — so the address has to be
        // here as well, or setup is unreachable for them.
        [`    Set up:    ${joinUrl}/setup`, '']
      : []),
    `    Join:      ${joinUrl}`,
    ...urls.slice(1).map((u) => `               ${u}`),
    `    Event PIN: ${eventPin}`,
    `    Onboarding page (QR + PIN + Android app):`,
    `               ${joinUrl}/connect`,
    '  └─────────────────────────────────────────────┘',
    '',
  ]
  console.log(lines.join('\n'))
  if (process.stdout.isTTY) {
    try {
      if (typeof require === 'function') {
        const qrcode = require('qrcode-terminal') as {
          generate: (text: string, opts: { small: boolean }) => void
        }
        qrcode.generate(`${joinUrl}/?pin=${encodeURIComponent(eventPin)}`, { small: true })
        console.log('  Scan to join — or open /connect on any screen.\n')
      }
    } catch {
      // QR is a nicety; the URLs above are the contract.
    }
  }
}
