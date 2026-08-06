import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import QRCode from 'qrcode-svg'
import { HOME_CHANNEL, newId, type PublicConfig, type User } from '@crewbox/shared'
import { DocsRelay, parseRoomName } from './docs.ts'
import { boxProbes, certNames, createEnvironmentCache, type Probes } from './environment.ts'
import { dnsConfigFile, dnsPlan } from './dnsconfig.ts'
import { escapeHtml, PAGE_CSS } from './html.ts'
import { LIVEKIT_PORT, probeSfu, type SfuFailure } from './livekit.ts'
import { lanAdapters, lanIps, latestApk } from './box.ts'
import { boxReadiness, worstState } from './readiness.ts'
import { parseUniverseList, type DmxListener } from './dmx/listener.ts'
import { dmxReadiness } from './dmx/readiness.ts'
import { setupPage } from './setup.ts'
import {
  isVoiceUpgrade,
  proxyVoiceHttp,
  proxyVoiceSocket,
  rejectVoiceUpgrade,
  VOICE_PROXY_PATH,
} from './voiceProxy.ts'
import { APP_VERSION } from './version.ts'
import { AdminTokens, hashPin, newAdminPassword, newToken, RateLimiter, verifyPin } from './auth.ts'
import { Hub } from './hub.ts'
import type { Store } from './store.ts'

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
/** Client-generated image preview; anything bigger is silently ignored. */
const MAX_THUMB_BYTES = 512 * 1024
/** Sanity bound for client-reported image dimensions. */
const MAX_IMAGE_EDGE_PX = 20_000

const joinBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .regex(/^[\p{L}\p{N} ()._'-]+$/u, "letters, numbers, spaces and ()._'- only"),
  eventPin: z.string().max(64).default(''),
  personalPin: z.string().regex(/^\d{4,8}$/, '4–8 digits'),
})

/** Client-reported pixel dimension: positive integer within sane bounds. */
function parseImageDim(value: string | undefined): number | undefined {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n <= MAX_IMAGE_EDGE_PX ? n : undefined
}

const historyQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

const contextQuerySchema = z.object({
  seq: z.coerce.number().int().positive(),
  radius: z.coerce.number().int().min(1).max(100).default(30),
})

const resetPinBodySchema = z.object({
  pin: z.string().regex(/^\d{4,8}$/, '4–8 digits'),
})

const channelPatchSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,31}$/, 'lowercase letters, numbers and dashes')
    .optional(),
  topic: z.string().max(200).optional(),
  retired: z.boolean().optional(),
})

/** An IPv4 address, or '' meaning "no preference". */
const ipv4OrEmpty = z
  .string()
  .trim()
  .max(45)
  .refine(
    (v) =>
      v === '' ||
      (/^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((octet) => Number(octet) <= 255)),
    'not an IPv4 address'
  )

/**
 * Network settings an admin can save. They live in the settings table so a
 * relaunch needs no terminal; the matching environment variables still win
 * when set, which keeps the terminal the recovery path for a bad save.
 */
const networkPatchSchema = {
  crewIface: ipv4OrEmpty.optional(),
  dmxMode: z.enum(['off', 'artnet', 'sacn', 'both']).optional(),
  dmxIface: ipv4OrEmpty.optional(),
  dmxUniverses: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === '' || parseUniverseList(v).length > 0, 'no universes in that list')
    .optional(),
}

const settingsPatchSchema = z.object({
  ...networkPatchSchema,
  /** What crew see instead of "Crewbox" once the box is set up for an event. */
  eventName: z.string().trim().max(64).optional(),
  wifiSsid: z.string().trim().max(64).optional(),
  // Changeable mid-event from the admin panel — no SSH, no service restart.
  eventPin: z.string().trim().min(4).max(64).optional(),
  /**
   * Not the event PIN. That one is printed on posters; this one is what
   * stands between a crew member and the admin panel, so it has a longer
   * floor and is never shown to anyone who hasn't already unlocked.
   */
  adminPassword: z.string().min(8).max(128).optional(),
})

const unlockBodySchema = z.object({
  password: z.string().min(1).max(128),
})

/**
 * Parse a single-range `Range: bytes=…` header. Returns the inclusive byte
 * window, 'unsatisfiable' (→ 416), or null to serve the whole file (absent,
 * malformed or multi-range headers all fall back to a plain 200).
 */
export function parseByteRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header || size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null // malformed or multi-range
  const [, startStr, endStr] = match
  if (startStr === '' && endStr === '') return null
  if (startStr === '') {
    // Suffix form: last N bytes.
    const suffix = Number(endStr)
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startStr)
  if (start >= size) return 'unsatisfiable'
  const end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

export interface AppDeps {
  store: Store
  eventPin: string
  /** Initial Wi-Fi SSID default; admin can override at runtime (settings table). */
  wifiSsid?: string
  /** Directory for uploaded files; omit to disable uploads (tests). */
  filesDir?: string
  /**
   * LiveKit connection details; omit to disable voice. `url` is an explicit
   * override (an SFU someone else runs). `embedded` means the box is running
   * its own, in which case the client URL is derived from whatever address
   * that client used to reach the box — a fixed URL would be wrong the
   * moment the box has two interfaces, which on site it usually does.
   */
  livekit?: { url: string; key: string; secret: string; embedded?: boolean; port?: number }
  /**
   * Why the embedded SFU refused to start, when it did and could tell.
   * Without this the admin panel reports "no voice server on this box" with
   * a fix about downloading a different build — actively wrong when the real
   * problem is another process squatting on the SFU's port.
   */
  voiceFailure?: SfuFailure
  /**
   * IP of the crew-facing adapter (CREWBOX_IFACE). Governs every address the
   * box advertises — QR, /connect, DNS suggestions — on a machine that also
   * sits on a lighting VLAN. Binding is the caller's half (see index.ts).
   * Env-only: the admin-saved value is read from the store live, so a save
   * in the panel redirects the QR without a restart.
   */
  iface?: string
  /**
   * What this process actually booted with, and which pieces came from the
   * environment — so the panel can say "saved, applies on restart" only when
   * it is true, and mark env-pinned fields as not editable here.
   */
  network?: {
    boot: { iface: string; dmxMode: string; dmxIface: string; dmxUniverses: string }
    env: { iface: boolean; dmxMode: boolean; dmxIface: boolean; dmxUniverses: boolean }
  }
  /**
   * Admin panel password from the environment. Overrides whatever is stored,
   * so it doubles as the way back in when the password is lost. Omit and the
   * box uses the stored one, minting and printing it on first start.
   */
  adminPassword?: string
  /** Sessions idle past this stop working; omit for non-expiring (tests). */
  sessionTtlMs?: number
  /** Trust X-Forwarded-For (behind cloudflared/Caddy) for client IPs. */
  trustProxy?: boolean
  /** Module ids this box enables; clients hide modules not listed. */
  modules?: string[]
  /** Data directory root; /connect offers the newest crewbox*.apk from here. */
  dataDir?: string
  /** Certificate material; when present the box serves HTTPS itself. */
  tls?: { cert: Buffer; key: Buffer; ca?: Buffer }
  /** Environment probes; injected in tests so nothing touches a network. */
  probes?: Probes
  /**
   * A running lighting-network listener, when this box was asked to listen.
   * Omit and the admin panel says so rather than reporting a silent rig.
   */
  dmx?: DmxListener
  logger?: boolean
}

export type App = FastifyInstance & {
  hub: Hub
  docs: DocsRelay
  /** Resolve a session token to its user (docs WS upgrades reuse this). */
  authSession: (token: string) => User | undefined
  /** Module ids this box enables (docs room namespaces are checked against it). */
  enabledModules: string[]
  /** SFU port to proxy voice signalling to, when the box runs its own. */
  voiceProxyPort?: number
}

export function buildApp({
  store,
  eventPin,
  wifiSsid = '',
  adminPassword,
  filesDir,
  livekit,
  voiceFailure,
  iface = '',
  network,
  sessionTtlMs,
  trustProxy = false,
  modules = ['chat'],
  dataDir,
  tls,
  probes,
  dmx,
  logger = true,
}: AppDeps): App {
  const fastify = Fastify({
    logger: logger ? { level: process.env.LOG_LEVEL ?? 'info' } : false,
    // Serving TLS directly is what removes Caddy from the deployment. Without
    // it the box can't ever give a browser a microphone or an installable
    // app, however the rest is packaged.
    ...(tls ? { https: { cert: tls.cert, key: tls.key, ...(tls.ca ? { ca: tls.ca } : {}) } } : {}),
    // Open WebSockets must never block shutdown — restarts have to be instant
    // and unattended on the festival box.
    forceCloseConnections: true,
    // Behind cloudflared/Caddy the socket peer is localhost; without this
    // every remote user shares one rate-limit bucket. Trust exactly ONE hop
    // (the tunnel), never trust:true — trust-all would take the left-most,
    // client-supplied X-Forwarded-For entry as req.ip, letting anyone forge
    // a fresh IP per request and walk straight past the PIN-guess limiter.
    trustProxy: trustProxy ? 1 : false,
  })

  // Effective public settings: DB override wins over the deploy-time default.
  // Admin-set PIN (settings table) wins over the deploy-time env default.
  const effectiveEventPin = (): string => store.getSetting('eventPin') ?? eventPin

  /**
   * The admin password, minted on first start if nobody has set one.
   *
   * It has to exist unconditionally, because the alternative is a box with no
   * way in. The rule this replaces — first person to join becomes admin —
   * had exactly that failure: the admin deletes their own account and the
   * panel is gone for good, with no recovery short of editing SQLite.
   *
   * A generated one is printed once, to the box's own console. Whoever can
   * see that screen is standing at the box, which is the same trust the QR
   * code it already prints depends on.
   */
  // ADMIN_PASSWORD wins over the stored one, and is the way back in when the
  // password is lost: put it in the service file, restart, you are an admin
  // again. That inversion is deliberate — for the event PIN the stored value
  // wins, because that one is changed mid-event from the panel and an env
  // default must not silently undo it. This one is the recovery hatch.
  const envAdminHash = adminPassword ? hashPin(adminPassword) : undefined
  // Held only for this process, only when we minted it: the setup page shows
  // it so an admin leaves that page knowing the password, rather than having
  // to go and find the box's console. A password inherited from an earlier
  // run is a hash and nothing else, and stays that way.
  let mintedAdminPassword: string | undefined

  const adminPasswordHash = (): string => {
    if (envAdminHash) return envAdminHash
    const stored = store.getSetting('adminPasswordHash')
    if (stored) return stored
    const generated = newAdminPassword()
    const hash = hashPin(generated)
    store.setSetting('adminPasswordHash', hash)
    mintedAdminPassword = generated
    fastify.log.warn(
      `\n\n  Admin password for this box: ${generated}\n` +
        `  Written down nowhere else. Change it in Admin → This box.\n`
    )
    return hash
  }
  // Minted at startup rather than on first use, so it reaches the console
  // while someone is still looking at it.
  adminPasswordHash()

  const publicConfig = (): PublicConfig => ({
    eventName: store.getSetting('eventName') ?? '',
    wifiSsid: store.getSetting('wifiSsid') ?? wifiSsid,
    voiceEnabled: voiceAvailable,
    modules,
  })

  // Warmed at startup so the admin panel reads a result rather than waiting
  // on one; see the route below.
  const environment = createEnvironmentCache(probes ?? boxProbes(dataDir))
  void environment.refresh()

  const hub = new Hub(store, fastify.log, publicConfig, sessionTtlMs, trustProxy, dmx)
  const docs = new DocsRelay()
  fastify.addHook('onClose', () => docs.close())
  if (sessionTtlMs) {
    const pruned = store.pruneSessions(sessionTtlMs)
    if (pruned > 0) fastify.log.info(`pruned ${pruned} expired session(s)`)
  }
  // Per-IP: every phone has its own LAN IP, so 10/min only throttles
  // PIN-guessing, not a crew rush after a briefing.
  const joinLimiter = new RateLimiter(Number(process.env.JOIN_RATE_LIMIT ?? 10), 60_000)
  // Per-ACCOUNT failed-login throttle: the IP limiter above doesn't stop a
  // multi-IP (botnet) attack on one crew member's short personal PIN once the
  // server is internet-exposed. Lock a name for a cooldown after 10 failures
  // regardless of source IP; a correct PIN clears it.
  const pinLimiter = new RateLimiter(10, 10 * 60_000)
  // Evict elapsed keys so the limiter maps can't grow unbounded under an
  // IP-rotating brute force. unref so it never holds the process open.
  // Unlocking the admin panel: 10 tries per IP per 10 minutes. The password
  // is long and random by default, so this only has to make an online guess
  // hopeless, not survive an offline crack.
  const adminLimiter = new RateLimiter(10, 10 * 60_000)
  // Twelve hours: long enough that nobody retypes it during a shift, short
  // enough that a phone left on a flightcase overnight is locked by morning.
  const adminTokens = new AdminTokens(12 * 60 * 60_000)
  const limiterSweep = setInterval(() => {
    joinLimiter.sweep()
    pinLimiter.sweep()
    adminLimiter.sweep()
    adminTokens.sweep()
  }, 5 * 60_000)
  limiterSweep.unref()
  fastify.addHook('onClose', () => clearInterval(limiterSweep))
  if (filesDir) mkdirSync(filesDir, { recursive: true })
  // Native wrappers load the bundle from the app package, so their requests
  // are cross-origin. Auth is bearer-token (no cookies), so open CORS adds
  // no CSRF surface on the crew LAN.
  void fastify.register(cors, { origin: true })
  void fastify.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 2 } })

  // The first-run setup page is a plain HTML form, so that it works before any
  // JavaScript has loaded and on whatever browser the box happened to open.
  // Fastify parses JSON only; this is the one route that posts a form.
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 4096 },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)))
    }
  )

  const authUser = (req: FastifyRequest): User | undefined => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return undefined
    return store.getSessionUser(header.slice('Bearer '.length), sessionTtlMs)
  }

  fastify.get('/api/health', () => ({
    ok: true,
    version: APP_VERSION,
    uptime: process.uptime(),
    ...hub.stats(),
    docs: docs.stats(),
  }))

  // Public settings the pre-auth join screen and offline screen need.
  fastify.get('/api/config', () => publicConfig())

  // Any crewbox*.apk in the data directory, newest first — release assets
  // carry the version in the filename, so the file works as downloaded.
  const apkFile = (): string | null => (dataDir ? latestApk(dataDir) : null)
  const apkAvailable = (): boolean => apkFile() !== null

  // Sideloadable Android app, dropped into DATA_DIR by the operator — no
  // reverse-proxy configuration needed to distribute it on site. The URL
  // stays /crewbox.apk whatever the file is called, so printed posters and
  // the Android in-app update check never go stale; the download itself is
  // named after the real file, which is where the version lives.
  fastify.get('/crewbox.apk', (_req, reply) => {
    const apkPath = apkFile()
    if (!apkPath) return reply.code(404).send({ error: 'no APK installed' })
    const filename = basename(apkPath).replace(/[^\w.-]/g, '_')
    return reply
      .header('content-type', 'application/vnd.android.package-archive')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(createReadStream(apkPath))
  })

  /**
   * The join URL crew should scan: the request host, unless the operator is
   * looking at localhost — then the first LAN address, which is what phones
   * can actually reach.
   */
  const voiceAvailable = Boolean(livekit?.url || livekit?.embedded)

  /** Hostname the client used to reach this box, without the port. */
  /** The box's own certificate, when it has one. */
  const readCertPem = (): string | null => {
    if (!dataDir) return null
    try {
      return readFileSync(join(dataDir, 'cert.pem'), 'utf8')
    } catch {
      return null
    }
  }

  /**
   * The crew adapter in effect: environment first, then whatever the admin
   * saved. Read per call so a save in the panel redirects the QR and
   * /connect immediately — the *binding* still applies on restart, and the
   * panel says so rather than pretending.
   */
  const effectiveIface = (): string => iface || store.getSetting('crewIface') || ''

  const storedNetwork = () => ({
    crewIface: store.getSetting('crewIface') ?? '',
    dmxMode: store.getSetting('dmxMode') ?? '',
    dmxIface: store.getSetting('dmxIface') ?? '',
    dmxUniverses: store.getSetting('dmxUniverses') ?? '',
  })

  /** What the next start will run with: env where set, saved otherwise. */
  const nextBootNetwork = () => {
    const saved = storedNetwork()
    const boot = network?.boot
    const env = network?.env
    return {
      iface: env?.iface && boot ? boot.iface : saved.crewIface,
      dmxMode: env?.dmxMode && boot ? boot.dmxMode : saved.dmxMode || 'off',
      dmxIface: env?.dmxIface && boot ? boot.dmxIface : saved.dmxIface,
      dmxUniverses: env?.dmxUniverses && boot ? boot.dmxUniverses : saved.dmxUniverses || '1-16',
    }
  }

  /** True when saved settings differ from what this process booted with. */
  const networkRestartNeeded = (): boolean =>
    network ? JSON.stringify(nextBootNetwork()) !== JSON.stringify(network.boot) : false

  /** The panel's Networks section, sent on GET and after a network save. */
  const networkPayload = () => ({
    adapters: lanAdapters(),
    saved: storedNetwork(),
    fromEnv: network?.env ?? { iface: false, dmxMode: false, dmxIface: false, dmxUniverses: false },
    advertised: lanIps(effectiveIface())[0] ?? '',
    restartNeeded: networkRestartNeeded(),
  })

  /** Best routable IPv4 — the crew adapter when configured — for DNS entries. */
  const lanAddress = (): string | undefined => lanIps(effectiveIface())[0]

  const hostOf = (req: FastifyRequest): string =>
    (req.headers.host ?? 'localhost').split(':')[0] || 'localhost'

  /**
   * Where this particular client should reach the SFU. An explicit url wins;
   * otherwise the embedded SFU is on the same host the request arrived on.
   */
  const voiceUrl = (req: FastifyRequest): string => {
    if (livekit?.url) return livekit.url
    if (!livekit?.embedded) return ''
    // Same origin as the page, so an https:// box doesn't hand back a ws://
    // URL the browser will refuse as mixed content. See voiceProxy.ts.
    const scheme = req.protocol === 'https' ? 'wss' : 'ws'
    return `${scheme}://${req.headers.host ?? 'localhost'}${VOICE_PROXY_PATH}`
  }

  const crewUrl = (req: FastifyRequest): string => {
    // req.protocol is 'https' when this box serves TLS itself, and falls back
    // to x-forwarded-proto only when trustProxy is on. Hardcoding http here
    // would print a QR pointing at a port that only speaks TLS.
    const proto = req.protocol
    const host = req.headers.host ?? 'localhost'
    if (!/^(localhost|127\.)/.test(host)) return `${proto}://${host}`
    const port = host.split(':')[1] ?? ''
    const ip = lanIps(effectiveIface())[0]
    if (ip) return `${proto}://${ip}${port ? `:${port}` : ''}`
    return `${proto}://${host}`
  }

  /**
   * First-run setup. Open only while nobody has joined — at that point anyone
   * who can reach the box can join and become admin anyway, so this grants
   * nothing extra; once the first person joins it closes for good and the
   * admin panel takes over. See setup.ts.
   */
  const setupOpen = (): boolean => store.countUsers() === 0

  const setupNetwork = () => {
    const saved = storedNetwork()
    return {
      adapters: lanAdapters(),
      crewIface: saved.crewIface,
      dmxMode: saved.dmxMode,
      dmxIface: saved.dmxIface,
      dmxUniverses: saved.dmxUniverses,
      fromEnv: network?.env ?? {
        iface: false,
        dmxMode: false,
        dmxIface: false,
        dmxUniverses: false,
      },
    }
  }

  const setupValues = () => ({
    eventName: store.getSetting('eventName') ?? '',
    wifiSsid: publicConfig().wifiSsid,
    eventPin: effectiveEventPin(),
    network: setupNetwork(),
    // undefined hides the field entirely — see SetupValues.
    ...(envAdminHash ? {} : { adminPassword: mintedAdminPassword ?? '' }),
  })

  const sendHtml = (reply: FastifyReply, html: string) =>
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(html)

  /**
   * Problems with the network the box is plugged into, worth raising here
   * because a dead DHCP lease or a hostname pointing at last year's box is
   * far cheaper to fix before the posters are printed. Only real problems:
   * `info` (chiefly "no internet", which is normal) stays silent, or the
   * first thing a new admin sees is a warning about something correct.
   */
  const setupWarnings = () =>
    (environment.current()?.checks ?? [])
      .filter((check) => check.state === 'off' || check.state === 'limited')
      .map(({ label, detail, fix }) => ({ label, detail, fix }))

  fastify.get('/setup', (req, reply) => {
    if (!setupOpen()) return reply.redirect('/connect')
    return sendHtml(
      reply,
      setupPage({ values: setupValues(), base: crewUrl(req), warnings: setupWarnings() })
    )
  })

  fastify.post('/setup', (req, reply) => {
    if (!setupOpen()) return reply.redirect('/connect')
    const body = (req.body ?? {}) as Record<string, unknown>
    // Blank means "leave the admin password alone", so it is dropped before
    // validation rather than failing the 8-character floor.
    const typedAdminPassword = String(body.adminPassword ?? '')
    const parsed = settingsPatchSchema.safeParse({
      eventName: String(body.eventName ?? ''),
      wifiSsid: String(body.wifiSsid ?? ''),
      eventPin: String(body.eventPin ?? ''),
      // Env-locked fields are not rendered, so their absence means "leave
      // alone" rather than "clear".
      ...(body.crewIface !== undefined ? { crewIface: String(body.crewIface) } : {}),
      ...(body.dmxMode !== undefined ? { dmxMode: String(body.dmxMode) } : {}),
      ...(body.dmxIface !== undefined ? { dmxIface: String(body.dmxIface) } : {}),
      ...(body.dmxUniverses !== undefined ? { dmxUniverses: String(body.dmxUniverses) } : {}),
      ...(typedAdminPassword ? { adminPassword: typedAdminPassword } : {}),
    })
    if (!parsed.success) {
      // Re-render with what they typed rather than throwing away the form.
      return sendHtml(
        reply.code(400),
        setupPage({
          values: {
            eventName: String(body.eventName ?? ''),
            wifiSsid: String(body.wifiSsid ?? ''),
            eventPin: String(body.eventPin ?? ''),
            network: setupNetwork(),
            ...(envAdminHash ? {} : { adminPassword: typedAdminPassword }),
          },
          base: crewUrl(req),
          error: parsed.error.issues.some((i) => i.path[0] === 'adminPassword')
            ? 'The admin password needs at least 8 characters.'
            : 'Event PIN needs at least 4 characters — everything else is optional.',
        })
      )
    }
    store.setSetting('eventName', parsed.data.eventName ?? '')
    store.setSetting('wifiSsid', parsed.data.wifiSsid ?? '')
    if (parsed.data.eventPin) store.setSetting('eventPin', parsed.data.eventPin)
    for (const key of ['crewIface', 'dmxMode', 'dmxIface', 'dmxUniverses'] as const) {
      const value = parsed.data[key]
      if (value !== undefined) store.setSetting(key, value)
    }
    // Ignored when ADMIN_PASSWORD is set: the form hides the field in that
    // case, so anything arriving here was hand-crafted.
    if (parsed.data.adminPassword && !envAdminHash) {
      store.setSetting('adminPasswordHash', hashPin(parsed.data.adminPassword))
      mintedAdminPassword = undefined
      adminTokens.revokeAll()
    }
    hub.announceConfig()
    return reply.redirect('/connect')
  })

  // Live onboarding page: big QR of the join URL (PIN prefilled), the PIN in
  // print, Wi-Fi guidance, and the APK when installed. Always current — a
  // PIN change from the admin panel is reflected on the next load, unlike a
  // printed poster. The URL under the QR is itself the join link: on a phone
  // this page was shared to, tapping it is scanning it.
  fastify.get('/connect', (req, reply) => {
    const config = publicConfig()
    const pin = effectiveEventPin()
    const base = crewUrl(req)
    const joinUrl = `${base}/?pin=${encodeURIComponent(pin)}`
    const qr = new QRCode({ content: joinUrl, padding: 2, width: 260, height: 260 }).svg()
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join ${escapeHtml(config.eventName || 'Crewbox')}</title>
<style>${PAGE_CSS}
  .qr { background: #fff; padding: 12px; border-radius: 16px; display: inline-block; margin: 20px 0; }
  .url { font-size: 20px; font-weight: 700; word-break: break-all; }
  .pin { font-size: 17px; margin-top: 10px; color: #f5b73e; }
</style></head><body><div class="card">
  <h1>${escapeHtml(config.eventName || 'Crewbox')}</h1>
  <p class="meta">Crew chat, voice &amp; patch sheets — on the event network</p>
  ${config.wifiSsid ? `<p class="meta">1. Join Wi-Fi: <strong>${escapeHtml(config.wifiSsid)}</strong>&nbsp;&nbsp;2. Scan&nbsp;&nbsp;3. Pick a name</p>` : ''}
  <div class="qr">${qr}</div>
  <p class="url"><a href="${escapeHtml(joinUrl)}">${escapeHtml(base.replace(/^https?:\/\//, ''))}</a></p>
  <p class="pin">Event PIN: <strong>${escapeHtml(pin)}</strong></p>
  ${apkAvailable() ? `<p class="meta">Android lock-screen alerts: <a href="${base}/crewbox.apk">download the Crewbox app</a></p>` : ''}
</div></body></html>`
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(html)
  })

  // Join doubles as login: a known name + matching personal PIN gets a new
  // session; an unknown name + correct event PIN creates the user.
  fastify.post('/api/join', (req, reply) => {
    if (!joinLimiter.allow(req.ip)) {
      return reply.code(429).send({ error: 'Too many attempts — wait a minute and try again' })
    }
    const parsed = joinBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    }
    const { name, eventPin: suppliedEventPin, personalPin } = parsed.data

    const existing = store.getUserByName(name)
    if (existing) {
      const accountKey = name.trim().toLowerCase()
      if (pinLimiter.blocked(accountKey)) {
        return reply
          .code(429)
          .send({ error: 'Too many wrong PINs for that name — wait a few minutes and try again.' })
      }
      if (!verifyPin(personalPin, existing.pinHash)) {
        pinLimiter.record(accountKey)
        return reply.code(401).send({
          error:
            "That name is taken and the PIN doesn't match. Pick another name, or use your PIN.",
        })
      }
      pinLimiter.clear(accountKey)
      const token = newToken()
      store.createSession(token, existing.id)
      const { pinHash: _, ...user } = existing
      return { token, user, created: false }
    }

    if (suppliedEventPin !== effectiveEventPin()) {
      return reply.code(401).send({ error: 'Wrong event PIN — check the join poster' })
    }
    // Everyone joins as a member. Admin is not something you are, it is
    // something you unlock with the password — because the old rule handed
    // the box permanently to whoever happened to scan the poster first, and
    // took it away for good if they ever deleted their account.
    const user = store.createUser(name, hashPin(personalPin), 'member')
    const token = newToken()
    store.createSession(token, user.id)

    hub.announceUser(user)
    const general = store.getChannelByName(HOME_CHANNEL)
    if (general) hub.systemMessage(general.id, `${user.name} joined`)

    return { token, user, created: true }
  })

  fastify.get('/api/me', (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    return { user }
  })

  // Delete your own account and personal data (App Store requirement).
  // Sessions, DM memberships and read state are removed; authored messages
  // are anonymized. Live sockets are dropped and the name frees up again.
  fastify.delete('/api/me', (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    store.deleteUser(user.id)
    hub.disconnectUser(user.id)
    return { ok: true }
  })

  // Upload a file; returns metadata to reference in a `send`. Identical
  // content is stored once (sha256 dedupe) under a fresh file id.
  fastify.post('/api/files', async (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    if (!filesDir) return reply.code(503).send({ error: 'uploads disabled' })

    // Multipart layout (all but `file` optional): width/height fields and a
    // small client-rendered `thumb` image part, then the `file` part itself.
    const fields: Record<string, string> = {}
    let thumb: Buffer | null = null
    let main: {
      tmpPath: string
      sha256: string
      name: string
      mime: string
      truncated: boolean
    } | null = null

    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (typeof part.value === 'string') fields[part.fieldname] = part.value
        continue
      }
      if (part.fieldname === 'thumb' && !thumb) {
        const chunks: Buffer[] = []
        let bytes = 0
        let over = false
        // Consume the WHOLE part — busboy won't emit the next part until this
        // stream ends. `break` here would call the iterator's return() and
        // destroy the stream, stalling the following `file` part; instead we
        // read to completion and just stop retaining bytes once over the cap.
        for await (const chunk of part.file) {
          bytes += (chunk as Buffer).length
          if (bytes > MAX_THUMB_BYTES) over = true
          if (!over) chunks.push(chunk as Buffer)
        }
        if (!over) thumb = Buffer.concat(chunks)
        continue
      }
      if (part.fieldname === 'file' && !main) {
        const tmpPath = join(filesDir, `tmp-${newId()}`)
        const hash = createHash('sha256')
        part.file.on('data', (chunk: Buffer) => hash.update(chunk))
        await pipeline(part.file, createWriteStream(tmpPath))
        main = {
          tmpPath,
          sha256: hash.digest('hex'),
          // 'thumb' is reserved by the preview route below.
          name: (part.filename === 'thumb' ? '_thumb' : part.filename || 'file').slice(0, 200),
          mime: part.mimetype || 'application/octet-stream',
          truncated: part.file.truncated,
        }
        continue
      }
      part.file.resume() // unknown part — drain and ignore
    }

    if (!main) return reply.code(400).send({ error: 'no file' })
    if (main.truncated) {
      await unlink(main.tmpPath)
      return reply.code(413).send({ error: 'file too large' })
    }

    const { size } = await stat(main.tmpPath)
    const existingPath = store.findPathBySha(main.sha256)
    let path: string
    if (existingPath) {
      await unlink(main.tmpPath)
      path = existingPath
    } else {
      path = join(filesDir, main.sha256)
      await rename(main.tmpPath, path)
    }

    // Dimensions and thumbnails only make sense for images; ignore otherwise.
    const isImage = main.mime.startsWith('image/')
    const width = isImage ? parseImageDim(fields.width) : undefined
    const height = isImage ? parseImageDim(fields.height) : undefined
    let thumbPath: string | undefined
    if (isImage && thumb && width && height) {
      thumbPath = `${path}.thumb`
      await writeFile(thumbPath, thumb)
    }

    const file = store.createFile({
      name: main.name,
      mime: main.mime,
      size,
      sha256: main.sha256,
      path,
      width,
      height,
      thumbPath,
    })
    return { file }
  })

  // Small JPEG preview generated by the uploading client (images only).
  fastify.get('/api/files/:id/thumb', (req, reply) => {
    const { id } = req.params as { id: string }
    const row = store.getFileRow(id)
    if (!row?.thumb_path) return reply.code(404).send({ error: 'not found' })
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(createReadStream(row.thumb_path))
  })

  // Files are addressed by unguessable ids (capability URLs) so <img> tags
  // work without auth headers on the crew LAN. Single-range requests are
  // honoured (206) — iOS Safari refuses to play video/audio without them.
  fastify.get('/api/files/:id/:name', async (req, reply) => {
    const { id } = req.params as { id: string; name: string }
    const row = store.getFileRow(id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    void reply
      .header('content-type', row.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('accept-ranges', 'bytes')

    const range = parseByteRange(req.headers.range, row.size)
    if (range === 'unsatisfiable') {
      return reply.code(416).header('content-range', `bytes */${row.size}`).send()
    }
    if (range) {
      return reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${row.size}`)
        .header('content-length', String(range.end - range.start + 1))
        .send(createReadStream(row.path, { start: range.start, end: range.end }))
    }
    return reply.header('content-length', String(row.size)).send(createReadStream(row.path))
  })

  // Remove a shared file: the message, its blob (dedup-safe) and a system
  // note. The author, or anyone with the panel unlocked — mistakes and wrong
  // maps must be fixable.
  fastify.delete('/api/messages/:id', (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    const message = store.getMessageById(id)
    if (!message) return reply.code(404).send({ error: 'message not found' })
    if (message.kind !== 'file') {
      return reply.code(400).send({ error: 'only shared files can be deleted' })
    }
    if (message.authorId !== user.id && !unlocked(req)) {
      return reply.code(403).send({ error: 'you can only delete your own files' })
    }
    store.deleteMessage(id)
    hub.announceDeleted(message.channelId, id)
    hub.systemMessage(message.channelId, `${user.name} removed a shared file`)
    return { ok: true }
  })

  // Voice signalling, proxied so it shares the box's port and certificate.
  if (livekit?.embedded) {
    fastify.all(`${VOICE_PROXY_PATH}/*`, (req, reply) => {
      proxyVoiceHttp(req.raw, reply.raw, livekit.port ?? LIVEKIT_PORT)
      return reply
    })
  }

  // Voice: mint a LiveKit room token for a channel's intercom room.
  fastify.post('/api/voice/token', async (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    if (!voiceAvailable) return reply.code(503).send({ error: 'voice not configured' })
    const parsed = z.object({ channelId: z.string().min(1) }).safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid request' })
    const channel = store.getChannel(parsed.data.channelId)
    if (!channel || !store.isMember(channel.id, user.id)) {
      return reply.code(404).send({ error: 'channel not found' })
    }
    const { AccessToken } = await import('livekit-server-sdk')
    const at = new AccessToken(livekit!.key, livekit!.secret, {
      identity: user.id,
      name: user.name,
      ttl: '12h',
    })
    at.addGrant({ room: channel.id, roomJoin: true, canPublish: true, canSubscribe: true })
    return { url: voiceUrl(req), token: await at.toJwt() }
  })

  fastify.get('/api/search', (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const { q } = req.query as { q?: string }
    if (!q?.trim()) return { messages: [] }
    const results = store
      .searchMessages(q, 50)
      .filter((m) => store.isMember(m.channelId, user.id))
      .slice(0, 25)
    return { messages: results }
  })

  // Scrollback history, oldest → newest, for messages before beforeSeq.
  fastify.get('/api/channels/:id/messages', (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    const channel = store.getChannel(id)
    if (!channel || !store.isMember(channel.id, user.id)) {
      return reply.code(404).send({ error: 'channel not found' })
    }
    const parsed = historyQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
    const { beforeSeq, limit } = parsed.data
    const messages = store.listBefore(channel.id, beforeSeq ?? channel.lastSeq + 1, limit)
    return { messages }
  })

  // Messages around one seq — jump-to-message from a search result.
  fastify.get('/api/channels/:id/context', (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    const channel = store.getChannel(id)
    if (!channel || !store.isMember(channel.id, user.id)) {
      return reply.code(404).send({ error: 'channel not found' })
    }
    const parsed = contextQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
    return { messages: store.listAround(channel.id, parsed.data.seq, parsed.data.radius) }
  })

  // -- admin ----------------------------------------------------------------

  const adminTokenOf = (req: FastifyRequest): string | undefined => {
    const header = req.headers['x-admin-token']
    return typeof header === 'string' ? header : undefined
  }

  /** True when this request carries a live unlock. Used for moderation too. */
  const unlocked = (req: FastifyRequest): boolean => adminTokens.valid(adminTokenOf(req))

  const authAdmin = (req: FastifyRequest, reply: FastifyReply): User | undefined => {
    const user = authUser(req)
    if (!user) {
      void reply.code(401).send({ error: 'unauthenticated' })
      return undefined
    }
    // 403 rather than 401: the session is fine, it is the unlock that is
    // missing or stale. The client tells them apart — 403 re-prompts for the
    // password, 401 sends them back to the join screen.
    if (!unlocked(req)) {
      void reply.code(403).send({ error: 'admin panel is locked' })
      return undefined
    }
    return user
  }

  /**
   * Unlock the admin panel by password.
   *
   * Requires a signed-in crew member as well as the password, so an unlock
   * always belongs to somebody — and so this route is not reachable at all
   * from an unauthenticated internet client when the box is behind a tunnel.
   */
  fastify.post('/api/admin/unlock', (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    if (!adminLimiter.allow(req.ip)) {
      return reply
        .code(429)
        .send({ error: 'Too many attempts — wait a few minutes and try again.' })
    }
    const parsed = unlockBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Enter the admin password.' })
    }
    if (!verifyPin(parsed.data.password, adminPasswordHash())) {
      return reply.code(401).send({ error: "That's not the admin password." })
    }
    adminLimiter.clear(req.ip)
    fastify.log.info(`admin panel unlocked by ${user.name}`)
    return { adminToken: adminTokens.issue() }
  })

  /** Give the unlock back early — the panel's Lock button. */
  fastify.post('/api/admin/lock', (req, reply) => {
    adminTokens.revoke(adminTokenOf(req))
    return reply.send({ ok: true })
  })

  // Reset a crew member's forgotten personal PIN. Their sessions stay valid —
  // this is recovery, not a ban.
  fastify.post('/api/admin/users/:id/pin', (req, reply) => {
    if (!authAdmin(req, reply)) return reply
    const parsed = resetPinBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    }
    const { id } = req.params as { id: string }
    if (!store.updateUserPin(id, hashPin(parsed.data.pin))) {
      return reply.code(404).send({ error: 'user not found' })
    }
    return { ok: true }
  })

  // Rename / retopic / retire a public channel.
  fastify.patch('/api/admin/channels/:id', (req, reply) => {
    const admin = authAdmin(req, reply)
    if (!admin) return reply
    const parsed = channelPatchSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    }
    const { id } = req.params as { id: string }
    const channel = store.getChannel(id)
    if (!channel || channel.kind !== 'public') {
      return reply.code(404).send({ error: 'channel not found' })
    }
    const { name, retired } = parsed.data
    if (name && name !== channel.name && store.getChannelByName(name)) {
      return reply.code(409).send({ error: `#${name} already exists` })
    }
    // The home channel anchors join announcements and the default view — keep it.
    if (retired && channel.name === HOME_CHANNEL) {
      return reply.code(400).send({ error: `cannot retire #${HOME_CHANNEL}` })
    }
    const updated = store.updateChannel(id, parsed.data)!
    hub.announceChannel(updated)
    if (name && name !== channel.name && !updated.retired) {
      hub.systemMessage(
        updated.id,
        `#${channel.name} is now #${updated.name} (renamed by ${admin.name})`
      )
    }
    return { channel: updated }
  })

  // Editable settings + read-only server info for the admin panel.
  /**
   * What the box has been plugged into, as opposed to what the box can do.
   * Separate from /api/admin/settings because probing a dead uplink is
   * discovered by waiting, and the settings panel must stay instant.
   *
   * The first sweep is kicked off at startup, so this is normally warm. A
   * caller that arrives first gets `null` and a "checking" state rather than
   * a request that hangs for several seconds.
   */
  fastify.get('/api/admin/environment', (req, reply) => {
    if (!authAdmin(req, reply)) return reply
    const refresh = (req.query as { refresh?: string } | undefined)?.refresh === '1'
    if (refresh) return environment.refresh()
    return environment.current() ?? { checks: [], probedAt: 0, pending: true }
  })

  /**
   * The local DNS entry this box needs, as a file to paste onto the router.
   *
   * The environment panel can tell an admin the name doesn't point here; this
   * is the part they can act on. Generated rather than documented because the
   * box already knows both halves — its address and its certificate's name —
   * and typing either one wrong fails silently.
   */
  fastify.get('/api/admin/dns-config', (req, reply) => {
    if (!authAdmin(req, reply)) return reply
    const pem = readCertPem()
    const hostname = pem ? certNames(pem)[0] : undefined
    const address = lanAddress()
    if (!hostname || !address) {
      return reply.code(404).send({
        error: !hostname
          ? 'This box has no certificate, so there is no name to point anywhere.'
          : 'This box has no LAN address to point a name at.',
      })
    }
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-disposition', 'attachment; filename="crewbox-dns.conf"')
      .send(dnsConfigFile(dnsPlan(hostname, address)))
  })

  fastify.get('/api/admin/settings', async (req, reply) => {
    if (!authAdmin(req, reply)) return reply
    const stats = hub.stats()
    // Asked live, on every panel open, rather than trusted from startup: the
    // SFU can die mid-show, and — found on a real MacBook — something else
    // can be squatting on its port, rejecting every token this box mints
    // while every config-derived answer reads "voice is fine". This is the
    // one check in the panel that talks to the thing it reports on.
    const sfu = livekit?.embedded
      ? await probeSfu(livekit.port ?? LIVEKIT_PORT, livekit.key, livekit.secret)
      : undefined
    const readiness = boxReadiness({
      // req.protocol is 'https' for a TLS connection, and honours
      // x-forwarded-proto only when this box is configured to trust a proxy.
      secure: req.protocol === 'https',
      voice: livekit?.embedded ? 'embedded' : livekit?.url ? 'external' : 'off',
      ...(sfu ? { sfu } : {}),
      ...(voiceFailure ? { voiceFailure } : {}),
      // Live, not from startup: adapters come and go on site (a cable pulled,
      // Wi-Fi re-joined), and the panel exists to say what is true now.
      iface: effectiveIface(),
      addresses: lanIps(effectiveIface()),
      restartNeeded: networkRestartNeeded(),
      dataDir: dataDir ?? process.cwd(),
      crewCount: store.listUsers().length,
      host: hostOf(req),
    })
    return {
      settings: { eventName: publicConfig().eventName, wifiSsid: publicConfig().wifiSsid },
      serverInfo: {
        version: APP_VERSION,
        uptimeSec: Math.round(process.uptime()),
        connections: stats.connections,
        onlineUsers: stats.onlineUsers,
        voiceEnabled: voiceAvailable,
        // Shown so admins can put the current PIN on posters; editable below.
        eventPin: effectiveEventPin(),
        // The admin password is never sent back — unlike the event PIN, there
        // is no reason for anyone to read it off a screen. This only says
        // whether the panel is allowed to change it.
        adminPasswordFromEnv: envAdminHash !== undefined,
      },
      readiness,
      readinessState: worstState(readiness),
      network: networkPayload(),
      // Its own panel rather than folded into the box checks: a lighting
      // network is a separate thing that can be fine while the box is not,
      // and the other way round.
      lighting: dmx
        ? dmxReadiness(
            dmx.snapshot(),
            dmx.state.health(),
            Date.now(),
            dmx.state.discovered(),
            dmx.state.nodes(),
            dmx.state.outages()
          )
        : dmxReadiness(
            {
              mode: 'off',
              artnet: { listening: false, error: null },
              sacn: { listening: false, error: null, joined: [], failed: [], discovery: false },
              interfaceIp: null,
              packets: 0,
              ignored: 0,
            },
            [],
            Date.now()
          ),
    }
  })

  fastify.patch('/api/admin/settings', (req, reply) => {
    if (!authAdmin(req, reply)) return reply
    const parsed = settingsPatchSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    }
    if (parsed.data.eventName !== undefined) {
      store.setSetting('eventName', parsed.data.eventName)
    }
    if (parsed.data.wifiSsid !== undefined) {
      store.setSetting('wifiSsid', parsed.data.wifiSsid)
    }
    if (parsed.data.eventPin !== undefined) {
      store.setSetting('eventPin', parsed.data.eventPin)
    }
    for (const key of ['crewIface', 'dmxMode', 'dmxIface', 'dmxUniverses'] as const) {
      const value = parsed.data[key]
      if (value !== undefined) store.setSetting(key, value)
    }
    let reissued: string | undefined
    if (parsed.data.adminPassword !== undefined) {
      // Saying nothing here would be worse than refusing: the panel would
      // report success and the old password would keep working, which is
      // exactly the sort of thing you discover at the wrong moment.
      if (envAdminHash) {
        return reply.code(409).send({
          error:
            'This box takes its admin password from ADMIN_PASSWORD in its service file. Change it there and restart, or unset it to manage the password here.',
        })
      }
      store.setSetting('adminPasswordHash', hashPin(parsed.data.adminPassword))
      // Every device unlocked with the old password loses it. Changing a
      // password you believe is compromised has to actually end the access it
      // granted, or it is theatre. The admin doing the changing gets a fresh
      // token back so they alone stay in.
      adminTokens.revokeAll()
      reissued = adminTokens.issue()
    }
    hub.announceConfig()
    const config = publicConfig()
    return {
      settings: {
        eventName: config.eventName,
        wifiSsid: config.wifiSsid,
        eventPin: effectiveEventPin(),
      },
      network: networkPayload(),
      ...(reissued ? { adminToken: reissued } : {}),
    }
  })

  // Full JSON dump for the post-event archive.
  fastify.get('/api/admin/export', (req, reply) => {
    if (!authAdmin(req, reply)) return reply
    const stamp = new Date().toISOString().slice(0, 10)
    return reply
      .header('content-disposition', `attachment; filename="crewbox-export-${stamp}.json"`)
      .send({
        exportedAt: Date.now(),
        users: store.listUsers(),
        channels: store.listAllChannels(),
        messages: store.listAllMessages(),
      })
  })

  return Object.assign(fastify, {
    hub,
    docs,
    authSession: (token: string) => store.getSessionUser(token, sessionTtlMs),
    enabledModules: modules,
    voiceProxyPort: livekit?.embedded ? (livekit.port ?? LIVEKIT_PORT) : undefined,
  })
}

/** Wire the /ws (chat) and /ws/docs/<room> (shared docs) upgrade paths. */
export function attachWs(app: App): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  app.hub.attach(wss)
  // Yjs updates are binary and can far exceed chat frames; own server, own cap.
  const docsWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  // Signalling frames are small; the cap is a guard, not a limit anyone hits.
  const voiceWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  docsWss.on('connection', (ws, room: string) => app.docs.connect(ws, room))

  const reject = (socket: import('node:stream').Duplex, status: number, label: string) => {
    socket.write(`HTTP/1.1 ${status} ${label}\r\n\r\n`)
    socket.destroy()
  }

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const { pathname } = url
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      return
    }
    if (isVoiceUpgrade(pathname)) {
      if (!app.voiceProxyPort) {
        rejectVoiceUpgrade(socket)
        return
      }
      const port = app.voiceProxyPort
      voiceWss.handleUpgrade(req, socket, head, (ws) => {
        proxyVoiceSocket(ws, req.url ?? '/', port)
      })
      return
    }
    if (pathname.startsWith('/ws/docs/')) {
      // Same credential as everything else: a crewbox session token. The
      // shared-token relay model this replaces is gone — no session, no docs.
      const token = url.searchParams.get('token') ?? ''
      const user = token ? app.authSession(token) : undefined
      if (!user) {
        reject(socket, 401, 'Unauthorized')
        return
      }
      let rawRoom: string
      try {
        rawRoom = decodeURIComponent(pathname.slice('/ws/docs/'.length))
      } catch {
        reject(socket, 403, 'Forbidden')
        return
      }
      const room = parseRoomName(rawRoom, app.enabledModules)
      if (!room) {
        reject(socket, 403, 'Forbidden')
        return
      }
      docsWss.handleUpgrade(req, socket, head, (ws) => docsWss.emit('connection', ws, room))
      return
    }
    socket.destroy()
  })
  return wss
}

/**
 * Answer on 127.0.0.1 as well, when the box is bound to one adapter.
 *
 * Binding to CREWBOX_IFACE is what keeps the web server off the lighting
 * VLAN, but a strict single-address bind would also take localhost away —
 * and localhost is load-bearing: it is the one address that is a secure
 * context on plain http (the mic test that diagnosed the MacBook), it is
 * what health checks and smoke scripts curl, and it is where a browser on
 * the box itself lands out of habit.
 *
 * A Node server binds one address, so localhost is a second tiny server
 * that forwards both plain requests and websocket upgrades into the real
 * one's emitter. Same handlers, same state, zero routing of its own.
 */
export function mirrorOnLoopback(app: App, port: number): Promise<() => Promise<void>> {
  const mirror = createServer((req, res) => {
    app.server.emit('request', req, res)
  })
  mirror.on('upgrade', (req, socket, head) => {
    app.server.emit('upgrade', req, socket, head)
  })
  return new Promise((resolve, reject) => {
    mirror.once('error', reject)
    mirror.listen(port, '127.0.0.1', () => {
      resolve(
        () =>
          new Promise<void>((done) => {
            mirror.close(() => done())
          })
      )
    })
  })
}
