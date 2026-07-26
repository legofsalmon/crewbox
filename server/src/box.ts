import { mkdirSync, writeFileSync } from 'node:fs'
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
