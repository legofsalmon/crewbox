import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import QRCode from 'qrcode-svg'
import {
  HOME_CHANNEL,
  MAX_MESSAGE_LENGTH,
  MAX_PROCESSOR_NAME,
  VIDEO_ACTIONS,
  newId,
  type PublicConfig,
  type User,
} from '@crewbox/shared'
import { DocsRelay, type RelayLimits, parseRoomName } from './docs.ts'
import { boxProbes, certNames, createEnvironmentCache, type Probes } from './environment.ts'
import { dnsConfigFile, dnsPlan } from './dnsconfig.ts'
import { redirectConfigFile, redirectPlan } from './portredirect.ts'
import { escapeHtml, PAGE_CSS } from './html.ts'
import { LIVEKIT_PORT, probeSfu, type SfuFailure } from './livekit.ts'
import { lanAdapters, lanIps, latestApk } from './box.ts'
import { boxReadiness, freeBytes, worstState } from './readiness.ts'
import { lastBackup } from './backupmark.ts'
import { readPower } from './power.ts'
import { parseUniverseList, type DmxListener } from './dmx/listener.ts'
import { dmxReadiness } from './dmx/readiness.ts'
import { mediaReadiness } from './netwatch/readiness.ts'
import type { NetWatch } from './netwatch/listener.ts'
import { createSocket as createDgramSocket } from 'node:dgram'
import { Collector } from './audit/collector.ts'
import { AUDIT_METRICS, BUNDLE_PAGE, type MetricsStore } from './audit/metrics.ts'

/**
 * How far back the comms-quality row looks.
 *
 * Long enough to survive a quiet patch between calls, short enough that
 * "comms were breaking up" means during this act rather than at load-in.
 */
const VOICE_QUALITY_WINDOW_MS = 10 * 60_000
import { Prober } from './audit/probes.ts'
import { scoreAudit } from './audit/score.ts'
import { setupPage } from './setup.ts'
import {
  isVoiceUpgrade,
  proxyVoiceHttp,
  proxyVoiceSocket,
  rejectVoiceUpgrade,
  VOICE_PROXY_PATH,
} from './voiceProxy.ts'
import { APP_VERSION } from './version.ts'
import {
  AdminTokens,
  hashPin,
  hashPinAsync,
  newAdminPassword,
  newToken,
  RateLimiter,
  verifyPinAsync,
} from './auth.ts'
import {
  controlKey,
  keyFromHeaders,
  keyMatches,
  readRunningOrder,
  stageBoard,
  Tally,
  TIMETABLE_ROOM,
} from './control.ts'
import { DELETION_REPLAY_MS, Hub, isPrivateIp } from './hub.ts'
import type { VideoService } from './video/service.ts'
import type { UpdateChecker } from './update/check.ts'
import type { UpdateService } from './update/service.ts'
import { describeInterruption } from './update/guard.ts'
import { InstallConfirmations } from './update/confirm.ts'
import type { Store } from './store.ts'

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/**
 * Disk this box will not let an upload eat into.
 *
 * The box's own code already says what a full disk costs: the audit rollup
 * throws on `SQLITE_FULL` inside an interval, and a box that filled its disk
 * on day four did not lose its graphs, it lost its comms. Nothing stopped
 * anybody filling it — a PIN holder with a phone and a hundred-megabyte
 * limit needs twenty uploads to take a small box down, and none of it looks
 * like an attack. It looks like somebody sharing videos.
 *
 * Two gigabytes is the same figure the readiness panel calls low, so a crew
 * that sees the disk row go amber has the reason: attachments have already
 * stopped, and everything that keeps a show running has not.
 */
const UPLOAD_DISK_RESERVE = 2 * 1024 * 1024 * 1024

/**
 * May this box take another attachment?
 *
 * `free` is null on a filesystem that will not answer, which is not evidence
 * of anything and must not stop a crew sharing a photograph. The worst-case
 * upload is what is subtracted, because the decision has to be made before a
 * byte is read — deciding afterwards means the file is already on the disk
 * this is protecting.
 */
export const roomForUpload = (
  free: number | null,
  maxUpload = MAX_UPLOAD_BYTES,
  reserve = UPLOAD_DISK_RESERVE
): boolean => free === null || free - maxUpload >= reserve
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

const incidentQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
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

/**
 * `null` clears; a string names a crew member by id or by name.
 *
 * `nullable` and not `optional`: a desk saying "nobody is on air" is a
 * statement, and an empty body arriving by accident should be a 400 rather
 * than a silent all-clear on a live camera.
 */
const tallyBodySchema = z.object({
  user: z.string().max(80).nullable(),
})

/**
 * A message posted from a desk. The channel is named the way whoever built
 * the button knows it — "#foh", "foh", or an id a script stored.
 */
const controlMessageSchema = z.object({
  channel: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
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

/**
 * Content types a browser may render inline from a crew-uploaded file.
 *
 * The file route serves attacker-controlled bytes from the app's own origin,
 * so anything a browser will *execute* — HTML, or SVG, which carries script —
 * is a stored-XSS vector against the session token in localStorage. This is
 * the allowlist of what crew genuinely share and view in place; a type not on
 * it is served as `application/octet-stream`, which downloads rather than
 * runs. `image/svg+xml` is deliberately excluded: it is an image to a human
 * and a script host to a browser.
 */
export function safeContentType(mime: string): string {
  const m = mime.toLowerCase()
  const inlineOk =
    (m.startsWith('image/') && m !== 'image/svg+xml') ||
    m.startsWith('video/') ||
    m.startsWith('audio/') ||
    m === 'application/pdf'
  return inlineOk ? mime : 'application/octet-stream'
}

/** A filename safe to drop in a Content-Disposition header: no quotes, no
 *  control characters, no path separators that could confuse a client. */
function attachmentName(name: string): string {
  return name.replace(/[^\w.\- ]/g, '_').slice(0, 200) || 'file'
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
   * How the OS-probe responder got on: whether it holds its port, and why
   * not when it doesn't. Settled at startup and never changes afterwards, so
   * a snapshot is honest. Omit and the readiness list leaves the row off —
   * which is right for a box that was never asked to run one.
   */
  captive?: { listening: boolean; port?: number; fallback?: boolean; reason?: string }
  /**
   * IP of the crew-facing adapter (CREWBOX_IFACE). Governs every address the
   * box advertises — QR, /connect, DNS suggestions — on a machine that also
   * sits on a lighting VLAN. Binding is the caller's half (see index.ts).
   * Env-only: the admin-saved value is read from the store live, so a save
   * in the panel redirects the QR without a restart.
   */
  iface?: string
  /**
   * The address this process is actually listening on, as index.ts resolved
   * it at boot.
   *
   * Not the same question as `iface`, and the readiness row used to answer
   * it by looking at the adapters as they are now. The bind was decided
   * once: a crew adapter that was down at boot means the box is answering on
   * *every* network, and once the cable is back in the old row said "the box
   * answers only there" — which is the answer an operator would act on, and
   * the wrong one. It lied in the other direction too, calling a box bound
   * to a departed address "answering everywhere".
   *
   * Absent in tests and when nothing has bound yet, in which case the row
   * falls back to describing the configuration.
   */
  boundHost?: string
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
  /** What the shared-docs relay will carry. Lowered in tests. */
  relayLimits?: Partial<RelayLimits>
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
  /** Media-network watchers (PTP/mDNS/SAP), when this box was asked to watch. */
  netwatch?: NetWatch
  /**
   * LED processor monitoring, when the video module is on.
   *
   * Unlike `dmx` and `netwatch`, whose presence means the box is already
   * listening, this one starts silent: it contacts nothing until an admin
   * has confirmed a specific processor twice. Omit it and the video routes
   * are not registered at all.
   */
  video?: VideoService
  /**
   * Asks whether a newer crewbox exists. Omit and the panel simply never
   * mentions updates — which is what a box told not to check should look
   * like, rather than a row saying it doesn't know.
   */
  updates?: UpdateChecker
  /**
   * Whether this box may make outbound connections at all.
   *
   * The same switch as the update check — `CREWBOX_UPDATE_CHECK=0`, whose
   * own documentation says "on a box whose network must make no outbound
   * connections at all". The environment sweep ignored it and made three
   * off-site connections at every startup regardless, so the promise was
   * only ever true of the update check itself.
   */
  outbound?: boolean
  /**
   * Downloading and installing one. Omit and the panel offers no button —
   * which is the right shape for a box running from source, where there is
   * no binary to swap.
   */
  updater?: UpdateService
  /**
   * Persistent audit history (rollups/events/probe runs). Omit and the
   * network-audit collector still runs in memory but writes nothing —
   * tests and the e2e box work without a metrics store.
   */
  metrics?: MetricsStore
  /**
   * The wall clock the running order is read against. Injected by tests, so
   * "what is on the main stage" can be asked at nine in the evening from a CI
   * runner at four in the morning. Production passes nothing.
   */
  clock?: () => Date
  /**
   * The festival's timezone (`CREWBOX_TZ`), when the box has been told one.
   * Unset, the running order is read against the box's own process zone.
   */
  timeZone?: string
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

/**
 * The setting that closes first-run setup for good.
 *
 * Reaches a real box's database — do not rename it, or every box in the
 * field re-opens its setup page the next time its crew list empties.
 */
export const SETUP_DONE_KEY = 'setupDone'

export function buildApp({
  store,
  eventPin,
  wifiSsid = '',
  adminPassword,
  filesDir,
  livekit,
  voiceFailure,
  captive,
  iface = '',
  boundHost,
  network,
  sessionTtlMs,
  trustProxy = false,
  relayLimits = {},
  modules = ['chat'],
  dataDir,
  tls,
  probes,
  dmx,
  netwatch,
  video,
  updates,
  outbound = true,
  updater,
  metrics,
  clock = () => new Date(),
  timeZone,
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
    // every remote user shares one rate-limit bucket.
    //
    // **By address, not by hop count.** A number here does not mean "trust
    // one hop" — Fastify compiles it to "take index 0 of the address chain",
    // whoever the peer is. So with `trustProxy: 1` a crew phone talking
    // straight to the box on the festival Wi-Fi had its *own*
    // `X-Forwarded-For` believed: `req.ip` became whatever it wrote, a fresh
    // value per request walked past all three per-IP limiters, and a junk
    // value became an unvalidated map key. Verified on this Fastify: from a
    // non-loopback peer, `trustProxy: 1` returned the forged header and the
    // address form returned the peer's real address.
    //
    // Naming the loopback addresses says what was meant all along: the
    // tunnel arrives on 127.0.0.1, so its header is the real client and
    // everything else's is a phone's opinion about itself.
    trustProxy: trustProxy ? '127.0.0.1,::1' : false,
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

  /**
   * What the crew's own devices said about comms over the window a show moves
   * in. Null when nobody has been on voice, which is a different thing from
   * clean and is reported as one — by the readiness list and by a desk alike.
   */
  const recentVoiceQuality = (): {
    concealedPct: number
    lossPct: number
    devices: number
  } | null => {
    if (!metrics) return null
    const now = Date.now()
    const worst = metrics.worstVoice(now - VOICE_QUALITY_WINDOW_MS, now)
    if (!worst) return null
    return { concealedPct: worst.concealedPct, lossPct: worst.lossPct, devices: worst.samples }
  }

  const publicConfig = (): PublicConfig => ({
    eventName: store.getSetting('eventName') ?? '',
    wifiSsid: store.getSetting('wifiSsid') ?? wifiSsid,
    voiceEnabled: voiceAvailable,
    modules,
  })

  // Warmed at startup so the admin panel reads a result rather than waiting
  // on one; see the route below.
  const envProbes = probes ?? boxProbes(dataDir)
  const environment = createEnvironmentCache(envProbes, outbound)
  void environment.refresh()

  const hub = new Hub(store, fastify.log, publicConfig, sessionTtlMs, trustProxy, dmx)
  const tally = new Tally()
  hub.setTally(tally)
  const docs = new DocsRelay(relayLimits)
  fastify.addHook('onClose', () => docs.close())

  // The network audit's collector: strictly a reader over the state the
  // passive listeners already keep — it opens no sockets and sends nothing.
  // Runs whenever the module is enabled; without a metrics store (tests,
  // e2e) it samples in memory and writes nothing.
  let collector: Collector | undefined
  let prober: Prober | undefined
  if (modules.includes('network')) {
    collector = new Collector(metrics, {
      hubStats: () => hub.stats(),
      ...(dmx
        ? {
            dmxHealth: () => dmx.state.health(),
            dmxOutages: () => dmx.state.outages(),
          }
        : {}),
      ...(netwatch
        ? {
            ptpStatus: (now: number) => netwatch.ptp.status(now),
            netwatchStatus: () => netwatch.snapshot(),
            mdnsRoster: () => netwatch.mdns.roster(),
            sapRoster: () => netwatch.sap.roster(),
          }
        : {}),
    })
    collector.start()
    // Crew phones report their own WS round trip once a minute; that is the
    // only honest source for "how bad is the Wi-Fi where the crew are".
    hub.setCollector(collector)
    fastify.addHook('onClose', () => collector?.stop())

    // The deep probe — the audit's one admin-push exception to "never
    // transmit". Sockets are created per sweep and closed with it; replies
    // land on the existing passive listeners (see audit/probes.ts).
    prober = new Prober(
      {
        createSocket: (options) => createDgramSocket(options),
        env: envProbes,
        now: Date.now,
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      {
        dmxIface: () => network?.boot.dmxIface ?? '',
        watchIface: () => netwatch?.snapshot().interfaceIp ?? '',
        ...(dmx ? { nodeCount: () => dmx.state.nodes().length } : {}),
        ...(netwatch ? { mdnsCount: () => netwatch.mdns.roster().length } : {}),
        certHostname: () => (tls ? certNames(tls.cert.toString())[0] : undefined),
        watching: () => Boolean(netwatch),
      },
      metrics
    )
  }
  if (sessionTtlMs) {
    const pruned = store.pruneSessions(sessionTtlMs)
    if (pruned > 0) fastify.log.info(`pruned ${pruned} expired session(s)`)
  }
  // Deletions past the replay window. Nothing pruned them, so a box that ran
  // a season put every deletion it had ever made into every welcome.
  {
    const pruned = store.pruneDeletions(Date.now() - DELETION_REPLAY_MS)
    if (pruned > 0) fastify.log.info(`pruned ${pruned} old deletion record(s)`)
  }
  // Per-IP: every phone has its own LAN IP, so 10/min only throttles
  // PIN-guessing, not a crew rush after a briefing.
  /**
   * The address to hold a rate limit against.
   *
   * `req.ip` is `X-Forwarded-For` when the box trusts a proxy, and that is a
   * string a client wrote — Fastify does not validate it, and Node will
   * carry up to 16 KB of header. Used raw it was both a way to get a fresh
   * limiter bucket per request and a way to fill the box's memory with map
   * keys. Address-based trust closes the LAN route to it; this closes the
   * rest, by refusing to key on anything that is not an address.
   */
  const limitKey = (req: FastifyRequest): string =>
    isIP(req.ip) ? req.ip : (req.socket.remoteAddress ?? 'unknown')

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
  // The control surface is a machine, not a person: a desk cutting cameras
  // sends far more than a human ever would, so this is generous — it exists
  // to stop a wrong key being guessed at, not to pace a Stream Deck.
  const controlLimiter = new RateLimiter(120, 60_000)
  // Twelve hours: long enough that nobody retypes it during a shift, short
  // enough that a phone left on a flightcase overnight is locked by morning.
  const adminTokens = new AdminTokens(12 * 60 * 60_000)
  const limiterSweep = setInterval(() => {
    joinLimiter.sweep()
    pinLimiter.sweep()
    adminLimiter.sweep()
    // Swept like the rest. It was not, so its map grew one entry per distinct
    // caller for the process lifetime — bounded now by MAX_TRACKED_KEYS, but
    // a bound reached by keeping every key is not the same as not keeping
    // them.
    controlLimiter.sweep()
    adminTokens.sweep()
  }, 5 * 60_000)
  limiterSweep.unref()
  fastify.addHook('onClose', () => clearInterval(limiterSweep))
  /**
   * Where a stored file actually is, now.
   *
   * Not `files.path`, which is absolute and was written by whichever box did
   * the upload. `deploy/restore.sh` explicitly supports restoring onto a
   * *different* rig — that is what a spare box is for — and a different rig
   * has a different data directory, so every attachment and every thumbnail
   * 404'd on the box the crew had just switched to.
   *
   * The layout has always been `<filesDir>/<sha256>`, so the path is a fact
   * about this box and the sha, not something worth carrying in a row. The
   * column stays: an older build reading a newer database still finds what it
   * expects, and `thumb_path` remains the flag for "a thumbnail was made".
   */
  const blobPath = (sha256: string): string | undefined =>
    filesDir ? join(filesDir, sha256) : undefined

  /**
   * Both resolvers answer "does *this* box hold these bytes", not "was a row
   * written for them" — so a database restored without its files directory
   * 404s the attachment instead of 500ing on a read of something absent.
   */
  const fileOnDisk = (sha256: string): string | undefined => {
    const path = blobPath(sha256)
    return path && existsSync(path) ? path : undefined
  }
  const thumbOnDisk = (sha256: string): string | undefined => {
    const path = blobPath(sha256)
    return path && existsSync(`${path}.thumb`) ? `${path}.thumb` : undefined
  }

  if (filesDir) {
    mkdirSync(filesDir, { recursive: true })
    // Sweep half-written uploads left by a client that dropped mid-transfer
    // (a phone leaving the AP during a 100 MB video). Each is a tmp-* file
    // the upload handler's finally could not reach because the process had
    // already moved on; unchecked they accrete over a multi-day event until
    // the disk fills and appendMessage throws SQLITE_FULL — comms down.
    try {
      for (const name of readdirSync(filesDir)) {
        if (name.startsWith('tmp-')) rmSync(join(filesDir, name), { force: true })
      }
    } catch {
      // A sweep that fails is not worth blocking startup — the box still
      // serves crew, and the next clean shutdown or sweep tidies up.
    }
  }
  // Native wrappers load the bundle from the app package, so their requests
  // are cross-origin. Auth is bearer-token (no cookies), so open CORS adds
  // no CSRF surface on the crew LAN.
  void fastify.register(cors, { origin: true })
  // `fields`, `fieldSize` and `parts` as well as the file caps: the handler
  // reads exactly `width`, `height` and `thumb`, and busboy was otherwise
  // happy to buffer as many form fields as a client cared to send, each
  // unbounded, entirely in memory on a box that is also carrying the show.
  void fastify.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 2, fields: 8, fieldSize: 256, parts: 12 },
  })

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

  /**
   * A short, stable name for the *device* a request came from.
   *
   * Derived from the session token, so it is the same across that device's
   * reconnects and different on that person's other phone — and it is a
   * hash, so nothing about the token travels with it. Used for the voice
   * identity, where "one identity per person" was silently a rule of "one
   * device per person": LiveKit disconnects the older participant when a
   * second joins with the same identity, so a stage manager with a phone in
   * a pocket and a tablet on the desk lost one of them to "Voice dropped"
   * every time they used the other.
   */
  const deviceKey = (req: FastifyRequest): string => {
    const header = req.headers.authorization ?? ''
    return createHash('sha256').update(header).digest('base64url').slice(0, 10)
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
    // What the next start will actually run with: the environment where it
    // has set something, the saved value otherwise.
    //
    // The panel needs this and not only `saved`. With CREWBOX_DMX pinning the
    // mode and nothing ever saved through the panel, `saved.dmxMode` is
    // empty — so a panel reading that alone concluded lighting was off and
    // hid the adapter and universes fields, which the environment does *not*
    // pin and are the two an operator on such a box actually has to set.
    effective: nextBootNetwork(),
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
    //
    // ...except through the box's own loopback mirror, which is plain HTTP by
    // construction — the tray and the setup page reach the box that way. The
    // request says http and the crew's port says https, so a QR printed from
    // the tray sent every phone to a port that would not talk to them.
    const proto = tls ? 'https' : req.protocol
    const host = req.headers.host ?? 'localhost'
    if (!/^(localhost|127\.)/.test(host)) return `${proto}://${host}`
    const port = host.split(':')[1] ?? ''
    const ip = lanIps(effectiveIface())[0]
    if (ip) return `${proto}://${ip}${port ? `:${port}` : ''}`
    return `${proto}://${host}`
  }

  /**
   * First-run setup. Open only while nobody has joined, and closed for good
   * the moment somebody does; the admin panel takes over from there. See
   * setup.ts.
   *
   * It can be open at all because a box with no crew on it is holding
   * nothing: no messages, no accounts, no uploads. The alternative is a
   * chicken and an egg — the page's whole job is to set the PIN that would
   * otherwise be guarding it.
   *
   * (This used to say that whoever could reach the box "can join and become
   * admin anyway, so this grants nothing extra". That stopped being true
   * when the admin panel got its own password: joining makes you crew, not
   * an admin. The latch below is what the argument rests on now.)
   *
   * **"For good" is what the latch is for.** This used to be `countUsers()
   * === 0` and nothing else, and `DELETE /api/me` really deletes the row —
   * so when the last account removed itself (the admin after testing, or the
   * whole crew at load-out, which the App Store requirement means the app
   * offers) the door swung back open on a box full of the event's messages.
   * Anyone who could reach it could then set a new event PIN and a new admin
   * password and read everything.
   */
  const setupOpen = (): boolean =>
    store.getSetting(SETUP_DONE_KEY) !== '1' && store.countUsers() === 0

  /** Close it, permanently. Cheap and idempotent; called wherever it is true. */
  const closeSetup = (): void => {
    if (store.getSetting(SETUP_DONE_KEY) !== '1') store.setSetting(SETUP_DONE_KEY, '1')
  }

  // A box that already has a crew has already been set up, whether or not it
  // was this build that did it. One write at boot is what closes the door on
  // every box already in the field.
  if (store.countUsers() > 0) closeSetup()

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

  /**
   * Which field the setup form should point at.
   *
   * Every failure but the admin password used to read "Event PIN needs at
   * least 4 characters", including a mistyped adapter address — so the one
   * field that was correct was the one being blamed, on the first page a new
   * admin ever sees.
   */
  const SETUP_FIELD_LABELS: Record<string, string> = {
    adminPassword: 'The admin password needs at least 8 characters.',
    eventPin: 'Event PIN needs at least 4 characters — everything else is optional.',
    eventName: 'That event name is too long.',
    wifiSsid: 'That Wi-Fi name is too long.',
    crewIface: 'The crew adapter needs to be an IPv4 address, or left blank.',
    dmxIface: 'The lighting adapter needs to be an IPv4 address, or left blank.',
    dmxMode: 'Pick one of the lighting modes.',
    dmxUniverses: 'Universes look like "1-16" or "1,5,9".',
  }

  const setupError = (issues: { path: PropertyKey[]; message: string }[]): string => {
    // The admin password first, whatever else also failed: it is the one
    // field the form clears on a re-render, so an unmentioned failure there
    // is a form that rejects the same submission twice with no explanation.
    const named = issues.find((i) => i.path[0] === 'adminPassword') ?? issues[0]
    const field = named ? String(named.path[0] ?? '') : ''
    return SETUP_FIELD_LABELS[field] ?? named?.message ?? 'Check the fields above.'
  }

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
          // Named by the field that actually failed. It used to blame the
          // event PIN for everything except the admin password, so a typo in
          // an adapter address sent whoever was setting the box up to stare
          // at a PIN that was fine.
          error: setupError(parsed.error.issues),
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
    // Setup has been completed, so it is over — the same latch as a first
    // join, for the other way through this door.
    closeSetup()
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
    /**
     * Whether this request is close enough to be shown the PIN.
     *
     * The page is a poster for a wall — a QR with the PIN prefilled, and the
     * PIN in print underneath, because somebody has to be able to type it.
     * That is right for a phone on the festival Wi-Fi looking at a screen in
     * the production office.
     *
     * It is not right for the internet. The runbook's tunnel section tells
     * operators to treat the event PIN as a real secret, while this page was
     * handing it, prefilled, to anybody who asked. So off the LAN the poster
     * still works — the QR, the URL, the Wi-Fi guidance — and the PIN is
     * something you have to already know.
     */
    const local = isPrivateIp(req.socket.remoteAddress ?? '') && isPrivateIp(req.ip)
    const joinUrl = local ? `${base}/?pin=${encodeURIComponent(pin)}` : `${base}/`
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
  ${
    local
      ? `<p class="pin">Event PIN: <strong>${escapeHtml(pin)}</strong></p>`
      : `<p class="meta">Ask the production office for the event PIN.</p>`
  }
  ${apkAvailable() ? `<p class="meta">Android lock-screen alerts: <a href="/crewbox.apk">download the Crewbox app</a></p>` : ''}
</div></body></html>`
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(html)
  })

  // Join doubles as login: a known name + matching personal PIN gets a new
  // session; an unknown name + correct event PIN creates the user.
  fastify.post('/api/join', async (req, reply) => {
    if (!joinLimiter.allow(limitKey(req))) {
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
      // Counted on arrival, not after the check.
      //
      // `verifyPinAsync` is scrypt: ~100 ms, deliberately. Recording the
      // attempt only afterwards left that whole window open, so every guess
      // that arrived inside it was verified before any of them had been
      // counted — forty simultaneous wrong PINs got forty 401s and not one
      // 429. On the LAN the per-IP limiter contains that; through the tunnel,
      // where the attacker chooses the address, it did not.
      //
      // `allow` is the arrival-counting form, and a correct PIN clears the
      // count below — so a crew member who fumbles their PIN twice and then
      // gets it right is not carrying two strikes into the evening.
      if (!pinLimiter.allow(accountKey)) {
        return reply
          .code(429)
          .send({ error: 'Too many wrong PINs for that name — wait a few minutes and try again.' })
      }
      if (!(await verifyPinAsync(personalPin, existing.pinHash))) {
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
    const user = store.createUser(name, await hashPinAsync(personalPin), 'member')
    // Somebody has joined, so setup is over — and stays over even if every
    // account is later deleted. See setupOpen.
    closeSetup()
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

    // Before a byte is read, not after: the point is not to write the file
    // and then decide. `freeBytes` returns null on a filesystem that will
    // not answer, which is not evidence of anything and is not treated as
    // a refusal.
    if (!roomForUpload(freeBytes(filesDir))) {
      return reply.code(507).send({
        error: 'the box is low on disk — attachments are off until somebody clears space',
      })
    }

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
    // A tmp file that is on disk and not yet renamed or deleted. Tracked at
    // handler scope so the finally can remove it however this handler exits —
    // a client abort mid-pipeline throws before `main` is even assigned, and
    // without this that half-written file would be orphaned forever.
    let pendingTmp: string | null = null

    try {
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
          pendingTmp = tmpPath
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
        pendingTmp = null
        return reply.code(413).send({ error: 'file too large' })
      }

      const { size } = await stat(main.tmpPath)
      // Content-addressed, so where these bytes belong is decided by their
      // hash and nothing else. Dedupe used to ask the database instead, and
      // on a restored box that answered with the *old* rig's absolute path —
      // a directory that does not exist here, so the thumbnail write below
      // threw and re-sharing an already-shared photo 500'd. Renaming into
      // place unconditionally is atomic, needs no query, and repairs a blob
      // that went missing under a row that survived.
      const path = join(filesDir, main.sha256)
      await rename(main.tmpPath, path)
      pendingTmp = null

      // Dimensions and thumbnails only make sense for images; ignore otherwise.
      const isImage = main.mime.startsWith('image/')
      const width = isImage ? parseImageDim(fields.width) : undefined
      const height = isImage ? parseImageDim(fields.height) : undefined
      let thumbPath: string | undefined
      if (isImage && thumb && width && height) {
        thumbPath = `${path}.thumb`
        /**
         * Written once, by whoever uploaded these bytes first.
         *
         * The blob is content-addressed, so the thumbnail is shared by every
         * message that ever carried this image — and it is generated by the
         * *client*, from a canvas, at whatever size and quality that phone
         * decided. So re-sharing a photo somebody had already shared quietly
         * replaced the preview under everybody's earlier messages with a new
         * device's rendering of it. Usually similar; occasionally a blank
         * frame from a WebView that had not finished decoding.
         *
         * `wx` fails rather than truncating, which is the whole point.
         */
        await writeFile(thumbPath, thumb, { flag: 'wx' }).catch(() => {
          // Already there, which means an earlier upload of the same bytes
          // made one. Theirs stands; the row still gets the path, because
          // `thumb_path` is the flag that says a thumbnail exists.
        })
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
    } finally {
      // Whatever went wrong — a dropped connection, a throw after the write —
      // never leave the half-written upload behind.
      if (pendingTmp) await unlink(pendingTmp).catch(() => {})
    }
  })

  // Small JPEG preview generated by the uploading client (images only).
  fastify.get('/api/files/:id/thumb', (req, reply) => {
    const { id } = req.params as { id: string }
    const row = store.getFileRow(id)
    // `thumb_path` is the flag — a thumbnail was made — and the path comes
    // from this box, not from whichever one wrote the row. See fileOnDisk.
    const path = row?.thumb_path ? thumbOnDisk(row.sha256) : undefined
    if (!path) return reply.code(404).send({ error: 'not found' })
    return (
      reply
        .header('content-type', 'image/jpeg')
        .header('cache-control', 'public, max-age=31536000, immutable')
        // The thumb bytes are the client's JPEG, but nosniff costs nothing and
        // keeps the whole file surface consistent.
        .header('x-content-type-options', 'nosniff')
        .send(createReadStream(path))
    )
  })

  // Files are addressed by unguessable ids (capability URLs) so <img> tags
  // work without auth headers on the crew LAN. Single-range requests are
  // honoured (206) — iOS Safari refuses to play video/audio without them.
  fastify.get('/api/files/:id/:name', async (req, reply) => {
    const { id } = req.params as { id: string; name: string }
    const row = store.getFileRow(id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    // Resolved against this box's data directory, not the row's absolute
    // path — see fileOnDisk. A restore onto a spare rig used to 404 here.
    const path = fileOnDisk(row.sha256)
    if (!path) return reply.code(404).send({ error: 'not found' })
    // The mime came from the uploader and the file lives on the app's own
    // origin, so a crew member (anyone with the poster PIN) could upload an
    // HTML page or a scripted SVG and, when another phone opens the link,
    // run JS where the session token lives. Two guards close that:
    // browsers may only render the media types crew actually share inline;
    // everything else downloads as an opaque attachment, and nosniff stops
    // the browser second-guessing either decision.
    const type = safeContentType(row.mime)
    void reply
      .header('content-type', type)
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-disposition',
        `${type === row.mime ? 'inline' : 'attachment'}; filename="${attachmentName(row.name)}"`
      )
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
        .send(createReadStream(path, { start: range.start, end: range.end }))
    }
    return reply.header('content-length', String(row.size)).send(createReadStream(path))
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
  //
  // In its own scope with the body parsers taken off. Fastify parses a
  // request body before the handler runs, so a JSON POST to the SFU arrived
  // here already drained — `req.pipe(target)` then had nothing to send and
  // the upstream request hung until it timed out — and anything else was
  // answered 415 before the proxy saw it at all. A proxy has no business
  // reading a body it is only carrying.
  if (livekit?.embedded) {
    void fastify.register((instance, _opts, done) => {
      instance.removeAllContentTypeParsers()
      instance.addContentTypeParser('*', (_req, payload, next) => next(null, payload))
      instance.all(`${VOICE_PROXY_PATH}/*`, (req, reply) => {
        proxyVoiceHttp(req.raw, reply.raw, livekit.port ?? LIVEKIT_PORT)
        return reply
      })
      done()
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
      // Per device, not per person — see `deviceKey`. Nothing on either side
      // reads the user id back out of this: the room shows `name`, and the
      // participant list keys on it only to tell chips apart.
      identity: `${user.id}:${deviceKey(req)}`,
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
    // Limited in SQL, not after: the filter used to run on the newest 50
    // hits, so a word somebody had used a lot in their own DMs pushed every
    // public match out of the window and the answer was "nothing".
    return { messages: store.searchMessages(q, user.id, 25) }
  })

  // -- network audit ---------------------------------------------------------
  //
  // Session-authed, not admin: the audit is for the whole crew (only
  // *triggering* active probes is an admin action, added with the prober).
  // Registered only when the network module is on, like the pane it feeds.
  if (modules.includes('network')) {
    const SCORE_WINDOW_MS = 15 * 60_000
    const EVENTS_WINDOW_MS = 60 * 60_000

    fastify.get('/api/audit', (req, reply) => {
      const user = authUser(req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      const now = Date.now()
      const report = scoreAudit({
        now,
        configured: { dmx: Boolean(dmx), watch: Boolean(netwatch) },
        hub: hub.stats(),
        ...(dmx
          ? {
              dmx: {
                health: dmx.state.health(),
                outages: dmx.state.outages(),
                discovered: dmx.state.discovered(),
                nodes: dmx.state.nodes(),
              },
            }
          : {}),
        ...(netwatch
          ? {
              ptp: netwatch.ptp.status(now),
              watch: netwatch.snapshot(),
              mdns: netwatch.mdns.roster(),
              sap: netwatch.sap.roster(),
            }
          : {}),
        recentSeries: (metric, key) =>
          metrics ? metrics.series(metric, key, now - SCORE_WINDOW_MS, now) : [],
        events: metrics ? metrics.events(now - EVENTS_WINDOW_MS, 500) : [],
        probe: metrics?.latestProbeRun() ?? null,
      })
      return {
        report,
        events: metrics ? metrics.events(now - 24 * 60 * 60_000, 200) : [],
        probe: metrics?.latestProbeRun() ?? null,
        probeRunning: prober?.running ?? false,
      }
    })

    // Starting a sweep is the admin's call — it is the one time the audit
    // transmits. Fire-and-forget: progress and results surface through the
    // ordinary GET above, which every open pane is already polling.
    fastify.post('/api/audit/probe', (req, reply) => {
      const admin = authAdmin(req, reply)
      if (!admin) return reply
      if (!prober) return reply.code(404).send({ error: 'not available' })
      if (prober.running) return reply.code(409).send({ error: 'a probe is already running' })
      prober.run(admin.name).catch((err) => {
        fastify.log.warn(`audit probe failed: ${String(err)}`)
      })
      return reply.code(202).send({ started: true })
    })

    const seriesQuerySchema = z.object({
      metric: z.enum(AUDIT_METRICS),
      key: z.string().max(32).default(''),
      from: z.coerce.number().int().min(0),
      to: z.coerce.number().int().min(0),
    })

    fastify.get('/api/audit/series', (req, reply) => {
      const user = authUser(req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      const parsed = seriesQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
      const { metric, key, from, to } = parsed.data
      // Clamp to a day of minutes so one request can't drag the whole table.
      const clampedFrom = Math.max(from, to - 24 * 60 * 60_000)
      const rows = metrics ? metrics.series(metric, key, clampedFrom, to) : []
      return { points: rows.map((r) => [r.ts, r.min, r.avg, r.max, r.count]) }
    })

    const bundleQuerySchema = z.object({
      from: z.coerce.number().int().min(0),
      to: z.coerce.number().int().min(0),
      limit: z.coerce.number().int().min(1).optional(),
      // The last row of the previous page, in the order the query sorts by.
      afterMetric: z.string().max(64).optional(),
      afterKey: z.string().max(128).optional(),
      afterTs: z.coerce.number().int().min(0).optional(),
    })

    /**
     * The raw rollups, for an exporter.
     *
     * Admin, and paged. It was neither: any crew session could ask for a
     * festival's week and the box would build the lot into one JSON
     * response on the loop it serves the show from — tens of thousands of
     * rows, hundreds of megabytes, comms down for as long as it took. The
     * pane itself has never used this route; it exists for an export nobody
     * has written yet, which is not a reason to leave it dangerous.
     */
    fastify.get('/api/audit/bundle', (req, reply) => {
      if (!authAdmin(req, reply)) return reply
      const parsed = bundleQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
      const { from, to, limit, afterMetric, afterKey, afterTs } = parsed.data
      const clampedFrom = Math.max(from, to - 7 * 24 * 60 * 60_000)
      const after =
        afterMetric !== undefined && afterKey !== undefined && afterTs !== undefined
          ? { metric: afterMetric, key: afterKey, ts: afterTs }
          : undefined
      const rows = metrics ? metrics.bundle(clampedFrom, to, limit ?? BUNDLE_PAGE, after) : []
      const last = rows.at(-1)
      return {
        rows,
        // Present only when there may be more: the caller passes these three
        // back as afterMetric/afterKey/afterTs.
        ...(rows.length === Math.min(limit ?? BUNDLE_PAGE, BUNDLE_PAGE) && last
          ? { next: { metric: last.metric, key: last.key, ts: last.ts } }
          : {}),
      }
    })
  }

  // -- show log --------------------------------------------------------------
  //
  // Live entries arrive over the WebSocket; this is the scrollback, the same
  // shape as a channel's. Session-authed and not admin-gated: the log is the
  // crew's account of their own night, and a stage manager asking a lighting
  // tech "what time did that happen" is the point of it.
  if (modules.includes('incident')) {
    fastify.get('/api/incidents', (req, reply) => {
      const user = authUser(req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      const parsed = incidentQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
      const { beforeSeq, limit } = parsed.data
      const before = beforeSeq ?? store.latestIncidentSeq() + 1
      return { incidents: store.listIncidentsBefore(before, limit) }
    })
  }

  // -- video: watching the LED wall ------------------------------------------
  //
  // Reading is the whole crew's. The sweep is an admin's, and needs
  // confirming.
  //
  // The line is drawn at what a request *is*, not at how much it matters. A
  // screens tech naming a processor and watching it produces addressed GETs
  // and nothing else — reads, at the same rate whoever asks for them — so
  // gating that behind the admin password would make the pane useless to the
  // person it is for while protecting nothing.
  //
  // The sweep is the exception because it is the one packet here that is not
  // a read of a named device: a broadcast to a whole segment, from a box that
  // may also be sitting on the crew Wi-Fi. That is a decision about somebody
  // else's network, so it needs the password and a separate confirmation.
  //
  // Watching still raises an intent, for everyone. Not as a permission —
  // there is nothing to withhold — but because a crew member is entitled to
  // read what the box is about to put on a show network before it does.
  if (modules.includes('video') && video) {
    const addSchema = z.object({
      host: z.string().min(7).max(15),
      name: z.string().max(MAX_PROCESSOR_NAME).optional(),
    })
    const intentSchema = z.object({
      action: z.enum(VIDEO_ACTIONS),
      processorId: z.string().max(64).optional(),
    })
    const watchSchema = z.object({ monitored: z.boolean() })

    /** The token from the first half of the confirmation, if this is the second. */
    const confirmationOf = (req: FastifyRequest): string | undefined => {
      const header = req.headers['x-video-confirm']
      return typeof header === 'string' ? header : undefined
    }

    fastify.get('/api/video/state', (req, reply) => {
      const user = authUser(req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      return {
        processors: video.watcher.statuses(),
        scan: video.lastScanRun,
        scanning: video.busy,
        canScan: video.canScan,
        interfaceIp: video.interfaceIp,
      }
    })

    // Adding an address contacts nothing, so it needs no intent and no
    // password — it is a note about the world, not permission to talk to it.
    // Whoever knows the processor's address is the screens tech, and making
    // them find an admin to type it in helps nobody.
    fastify.post('/api/video/processors', (req, reply) => {
      const user = authUser(req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      const parsed = addSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid processor' })
      const result = video.store.add({
        host: parsed.data.host,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        addedBy: user.name,
      })
      if (!result.ok) return reply.code(400).send({ error: result.reason })
      return { processor: result.processor }
    })

    // Removing stops traffic and loses a note. Both are the safe direction,
    // so it takes no more than a session — the same rule as deleting a patch
    // sheet.
    fastify.delete('/api/video/processors/:id', (req, reply) => {
      const user = authUser(req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      const { id } = req.params as { id: string }
      if (!video.store.remove(id)) return reply.code(404).send({ error: 'no such processor' })
      return { removed: true }
    })

    /**
     * Half one of the confirmation: say what would happen.
     *
     * Answers with a single-use token and the exact traffic it would
     * authorise. Raising an intent sends nothing, so the guard here is only
     * whatever the *second* half will need — the admin password for a sweep,
     * a session for watching. Handing out a scan token to anyone would make
     * the password on `/api/video/scan` the only thing holding, and one lock
     * is easier to leave open than two.
     */
    fastify.post('/api/video/intent', (req, reply) => {
      const parsed = intentSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid request' })
      const user = parsed.data.action === 'scan' ? authAdmin(req, reply) : authUser(req)
      if (!user) {
        // authAdmin has already answered; authUser has not.
        return parsed.data.action === 'scan'
          ? reply
          : reply.code(401).send({ error: 'unauthenticated' })
      }
      const processor = parsed.data.processorId
        ? video.store.get(parsed.data.processorId)
        : undefined
      if (parsed.data.action === 'watch' && !processor) {
        return reply.code(404).send({ error: 'no such processor' })
      }
      const described = video.describe({
        userId: user.id,
        action: parsed.data.action,
        ...(processor ? { processor } : {}),
      })
      if (!described.ok) return reply.code(409).send({ error: described.reason })
      return { intent: described.intent }
    })

    /** Half two, for the scan. Without the token from above this sends nothing. */
    fastify.post('/api/video/scan', (req, reply) => {
      const admin = authAdmin(req, reply)
      if (!admin) return reply
      const spent = video.intents.consume({
        token: confirmationOf(req),
        userId: admin.id,
        action: 'scan',
      })
      if (!spent.ok) return reply.code(428).send({ error: spent.reason })
      if (video.busy) return reply.code(409).send({ error: 'a scan is already running' })
      video.runScan(admin.name).catch((err) => {
        fastify.log.warn(`video scan failed: ${String(err)}`)
      })
      return reply.code(202).send({ started: true })
    })

    /**
     * Half two, for monitoring one processor.
     *
     * A session, not the admin password: everything this starts is an
     * addressed GET. The confirmation stays for everyone, because reading
     * what the box is about to put on a show network is worth a screen
     * whoever is looking at it.
     *
     * Turning it *off* deliberately needs no confirmation: stopping is not a
     * transmission, and anything that makes stopping harder than starting is
     * the wrong way round on a show day.
     */
    fastify.post('/api/video/processors/:id/watch', (req, reply) => {
      const user = authUser(req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      const { id } = req.params as { id: string }
      const parsed = watchSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid request' })
      if (!video.store.get(id)) return reply.code(404).send({ error: 'no such processor' })

      if (!parsed.data.monitored) {
        video.store.setMonitored(id, false)
        return { monitored: false }
      }

      const spent = video.intents.consume({
        token: confirmationOf(req),
        userId: user.id,
        action: 'watch',
        processorId: id,
      })
      if (!spent.ok) return reply.code(428).send({ error: spent.reason })
      video.store.setMonitored(id, true, user.name)
      // Read it straight away rather than making somebody wait 20 s to find
      // out whether the address was right — but do not wait for the answer.
      // A mistyped address costs an SNMP timeout plus six HTTP ones, half a
      // minute of it, and holding the response open for that leaves an admin
      // watching a spinner with no idea whether anything happened. The pane
      // polls; the result lands there.
      void video.watcher.tick().catch((err: unknown) => {
        fastify.log.warn(`video: first read of ${id} failed: ${String(err)}`)
      })
      return { monitored: true }
    })
  }

  // -- updating the box ------------------------------------------------------
  //
  // Admin-only throughout, and the install needs a second, separate request.
  //
  // The line here is different from the video module's. There, reading was
  // the crew's because a read is a read. Here even the *download* is an
  // admin's: it spends the venue's uplink and fills the box's disk, and the
  // install takes every phone offline. None of that is a crew member's
  // decision to make.
  //
  // The confirmation exists for the same reason it does on the video sweep:
  // so there is no single request, however it is made, that takes a box off
  // the air. Arming answers with exactly what is about to be interrupted —
  // who is connected, what the running order says is on — and installing
  // needs that answer handed back.
  if (updater) {
    const confirmations = new InstallConfirmations()
    const installSchema = z.object({ version: z.string().min(2).max(64) })

    /** What is about to happen, if anything is. */
    const interruption = () =>
      describeInterruption({
        ...hub.stats(),
        board: stageBoard(readRunningOrder(docs.peek(TIMETABLE_ROOM)), clock(), timeZone),
      })

    fastify.get('/api/admin/update', (req, reply) => {
      const admin = authAdmin(req, reply)
      if (!admin) return reply
      return {
        flow: updater.state(),
        available: updates?.state().available ?? null,
        interruption: interruption(),
      }
    })

    /** Fetch and verify a build. Installs nothing. */
    fastify.post('/api/admin/update/download', (req, reply) => {
      const admin = authAdmin(req, reply)
      if (!admin) return reply
      const parsed = installSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid version' })
      const started = updater.start(parsed.data.version)
      if (!started.ok) return reply.code(409).send({ error: started.reason })
      // 202: the download outlives this request by a long way.
      return reply.code(202).send({ started: true })
    })

    /**
     * Half one of the confirmation: what installing right now would interrupt.
     *
     * Answers even when it would interrupt a headline set — that is the whole
     * point of warn-but-never-block. What it will not do is let the answer be
     * spent on a different version than the one it described.
     */
    fastify.post('/api/admin/update/intent', (req, reply) => {
      const admin = authAdmin(req, reply)
      if (!admin) return reply
      const parsed = installSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid version' })
      const flow = updater.state()
      if (flow.stage !== 'ready' || flow.version !== parsed.data.version) {
        return reply.code(409).send({ error: 'that build is not downloaded and verified' })
      }
      return {
        intent: confirmations.arm({
          userId: admin.id,
          version: parsed.data.version,
          interruption: interruption(),
        }),
      }
    })

    /** Half two. Without the token from above this installs nothing. */
    fastify.post('/api/admin/update/install', async (req, reply) => {
      const admin = authAdmin(req, reply)
      if (!admin) return reply
      const parsed = installSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid version' })
      const header = req.headers['x-update-confirm']
      const spent = confirmations.consume({
        token: typeof header === 'string' ? header : undefined,
        userId: admin.id,
        version: parsed.data.version,
      })
      if (!spent.ok) return reply.code(428).send({ error: spent.reason })

      // Awaited, unlike the download: this only ever returns when something
      // has gone wrong. On success the new box is serving and this process
      // has already been told to leave, so the reply is never written.
      const result = await updater.install()
      if (!result.ok) return reply.code(500).send({ error: result.reason })
      return { installed: true }
    })

    /** Clear a failure so the panel offers to try again. */
    fastify.post('/api/admin/update/reset', (req, reply) => {
      const admin = authAdmin(req, reply)
      if (!admin) return reply
      updater.reset()
      confirmations.clear()
      return { flow: updater.state() }
    })
  }

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
  fastify.post('/api/admin/unlock', async (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    // Counted before the hash, so a burst cannot outrun the limiter.
    if (!adminLimiter.allow(limitKey(req))) {
      return reply
        .code(429)
        .send({ error: 'Too many attempts — wait a few minutes and try again.' })
    }
    const parsed = unlockBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Enter the admin password.' })
    }
    // Async: scrypt is up to ~200 ms on an ARM box and this route is
    // reachable by any crew member, so the synchronous form froze the one
    // event loop the whole box shares — chat, DMX ticks and heartbeats —
    // for every attempt, including every wrong one.
    if (!(await verifyPinAsync(parsed.data.password, adminPasswordHash()))) {
      return reply.code(401).send({ error: "That's not the admin password." })
    }
    adminLimiter.clear(limitKey(req))
    fastify.log.info(`admin panel unlocked by ${user.name}`)
    return { adminToken: adminTokens.issue() }
  })

  // -- control surface -------------------------------------------------------
  //
  // Keyed, and deliberately not the admin password. See control.ts.

  /**
   * True when this request carried the box's control key; otherwise it has
   * already been refused and the caller should stop.
   *
   * Only *wrong* keys are counted against the limiter. A desk polling the
   * state twice a second is doing exactly what this surface is for, and
   * throttling it would turn a busy show into a dead button; a wrong key is
   * the only thing worth slowing down. Being over the limit is a 429 and not
   * a 401, because "bad or missing key" sends whoever built the button off
   * to check a key that was right all along.
   */
  const authControl = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (keyMatches(keyFromHeaders(req.headers as Record<string, unknown>), controlKey(store))) {
      return true
    }
    if (!controlLimiter.allow(limitKey(req))) {
      void reply.code(429).send({ error: 'too many bad keys — wait a minute and try again' })
      return false
    }
    void reply.code(401).send({ error: 'bad or missing key' })
    return false
  }

  /**
   * Raise or clear the on-air tally.
   *
   * `{ "user": "<id or name>" }` to light somebody up, `{ "user": null }` to
   * clear. Names are accepted as well as ids because the thing calling this
   * is a button somebody configured once, and "Dev Okafor" is what they know
   * — an id would mean looking it up and rebuilding the button if the crew
   * member is ever recreated.
   */
  fastify.post('/api/control/tally', (req, reply) => {
    if (!authControl(req, reply)) return reply
    const parsed = tallyBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'send { "user": "<id or name>" } or { "user": null }' })
    }

    const wanted = parsed.data.user
    let userId: string | null = null
    if (wanted) {
      const users = store.listUsers()
      const match =
        users.find((u) => u.id === wanted) ??
        users.find((u) => u.name.toLowerCase() === wanted.toLowerCase())
      if (!match) return reply.code(404).send({ error: `no crew member "${wanted}"` })
      userId = match.id
    }

    if (tally.set(userId)) hub.broadcastTally(tally.current())
    return { ok: true, ...tally.current() }
  })

  /** What is on air now, for a desk that reconnected and wants to resync. */
  fastify.get('/api/control/tally', (req, reply) => {
    if (!authControl(req, reply)) return reply
    return tally.current()
  })

  /**
   * Everything a button can show: the event, who is on air, how many crew are
   * on, what the comms sounded like, and what is on which stage.
   *
   * One request rather than five, because a Stream Deck polls this a second
   * at a time all night and every extra round trip is a thing that can be
   * half-configured. Read-only, and it deliberately says nothing about what
   * anybody wrote — a key on a desk is not a key to the crew's messages.
   */
  fastify.get('/api/control/state', (req, reply) => {
    if (!authControl(req, reply)) return reply
    const wanted = (req.query as { stage?: string } | undefined)?.stage?.trim().toLowerCase()
    const stats = hub.stats()
    const onAir = tally.current()

    // Only while a phone on site has the app open: the relay holds documents
    // for connected clients and nothing else, so an empty box genuinely does
    // not know the running order rather than knowing it is empty.
    const timetable = docs.peek(TIMETABLE_ROOM)
    const board = stageBoard(readRunningOrder(timetable), clock(), timeZone)

    return {
      event: publicConfig().eventName,
      version: APP_VERSION,
      onAir: {
        ...onAir,
        // The desk asked by name; answer by name as well as by id, so a
        // button's feedback text needs no second lookup.
        name: onAir.userId ? (store.getUserById(onAir.userId)?.name ?? '') : '',
      },
      crew: { online: stats.onlineUsers, total: store.countUsers() },
      voice: {
        enabled: voiceAvailable,
        // What crew devices reported over the last ten minutes, as numbers
        // rather than a verdict — the thresholds that turn these into "comms
        // are struggling" belong in one place, and that place is the
        // readiness list. A desk can colour a button however it likes.
        quality: recentVoiceQuality(),
      },
      // Public channels only, and only their names: this is the list a
      // message button offers, not a directory of who is talking to whom.
      channels: store
        .listAllChannels()
        .filter((channel) => channel.kind === 'public' && !channel.retired)
        .map((channel) => ({ id: channel.id, name: channel.name })),
      runningOrder: {
        known: timetable !== null,
        stages: wanted ? board.filter((s) => s.stage.toLowerCase() === wanted) : board,
      },
    }
  })

  /**
   * Post a message into a channel from the desk.
   *
   * The call every festival actually wants: the button that already fires the
   * changeover music also tells the crew it has started. It lands as a system
   * message — the box speaking, in the same voice as "#foh created" — because
   * a machine posting under a crew member's name is a machine putting words
   * in somebody's mouth, and on a comms channel that is how a wrong
   * instruction gets followed.
   *
   * Public channels only. A key sitting in a desk config file must never be
   * able to write into a DM.
   */
  fastify.post('/api/control/message', (req, reply) => {
    if (!authControl(req, reply)) return reply
    const parsed = controlMessageSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'send { "channel": "<name or id>", "body": "<message>" }' })
    }
    const wanted = parsed.data.channel.replace(/^#/, '')
    const channel = store.getChannel(wanted) ?? store.getChannelByName(wanted.toLowerCase())
    if (!channel || channel.kind !== 'public' || channel.retired) {
      return reply.code(404).send({ error: `no channel "${parsed.data.channel}"` })
    }
    const message = hub.systemMessage(channel.id, parsed.data.body)
    return { ok: true, channelId: channel.id, channel: channel.name, seq: message.seq }
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

  /**
   * The rule that gets port 80 to the probe responder, when the box could
   * not take that port itself.
   *
   * Offered only in that state — a box holding port 80 needs no redirect,
   * and a box with no responder at all has a different problem. The adapter
   * name is resolved here rather than typed by an admin: it is the one field
   * nobody can guess (en6 on one Mac is en0 on the next), and getting it
   * wrong loads a rule that silently does nothing.
   */
  fastify.get('/api/admin/port80-config', (req, reply) => {
    if (!authAdmin(req, reply)) return reply
    if (!captive?.listening || !captive.fallback) {
      return reply.code(404).send({
        error: captive?.listening
          ? 'This box already answers on port 80, so nothing needs redirecting.'
          : 'This box is not running a connectivity-check responder, so there is nothing to redirect to.',
      })
    }
    const iface = effectiveIface()
    const adapters = lanAdapters()
    const chosen = iface
      ? adapters.find((a) => a.address === iface)
      : // No pinned crew adapter: the join QR points at the first address,
        // so that is the network phones are on and the one to scope to.
        adapters.find((a) => a.address === lanIps()[0])
    if (!chosen) {
      return reply
        .code(404)
        .send({ error: 'This box has no LAN adapter to attach a redirect rule to.' })
    }
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-disposition', 'attachment; filename="crewbox-port80.conf"')
      .send(
        redirectConfigFile(
          redirectPlan({
            iface: chosen.name,
            address: chosen.address,
            port: captive.port ?? 80,
          })
        )
      )
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
    // Asked live, like the SFU probe: a box that was on mains at startup is
    // exactly the one someone has since unplugged. Null on a machine with no
    // battery, or where asking is not worth the cost — the row drops out
    // rather than being guessed at.
    const power = await readPower()
    // What the crew's own devices said, over the window a show moves in.
    // Absent when nobody has been on voice, which is a different thing from
    // clean and is reported as one.
    const voiceQuality = recentVoiceQuality()
    const readiness = boxReadiness({
      // req.protocol is 'https' for a TLS connection, and honours
      // x-forwarded-proto only when this box is configured to trust a proxy.
      //
      // A box that serves TLS is secure whatever this particular request
      // arrived on: the loopback mirror is plain HTTP by construction, so
      // opening the panel from the tray reported the box as insecure and
      // told the operator to get a certificate they already had.
      secure: Boolean(tls) || req.protocol === 'https',
      voice: livekit?.embedded ? 'embedded' : livekit?.url ? 'external' : 'off',
      ...(sfu ? { sfu } : {}),
      ...(voiceFailure ? { voiceFailure } : {}),
      ...(captive ? { captive } : {}),
      ...(power ? { power } : {}),
      // null rather than undefined when there is no marker: the box looked,
      // and "never backed up" is the answer worth printing.
      ...(dataDir ? { backup: lastBackup(dataDir) } : {}),
      // Live, not from startup: adapters come and go on site (a cable pulled,
      // Wi-Fi re-joined), and the panel exists to say what is true now.
      iface: effectiveIface(),
      addresses: lanIps(effectiveIface()),
      // What the box is really answering on, not what the adapters suggest.
      ...(boundHost ? { boundHost } : {}),
      restartNeeded: networkRestartNeeded(),
      // The zone the running order is read against, so the panel can print
      // the time the box thinks it is and an admin can check it in a glance.
      ...(timeZone ? { timeZone } : {}),
      dataDir: dataDir ?? process.cwd(),
      crewCount: store.listUsers().length,
      host: hostOf(req),
      ...(voiceQuality ? { voiceQuality } : {}),
    })
    return {
      settings: { eventName: publicConfig().eventName, wifiSsid: publicConfig().wifiSsid },
      serverInfo: {
        version: APP_VERSION,
        // Null when this box was told not to check, which the panel shows as
        // nothing at all rather than as an unknown.
        update: updates ? updates.state() : null,
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
        // Drives the "Download port 80 config" button. Sent as a flag rather
        // than inferred from the readiness row's wording, so rephrasing that
        // row can never silently remove the fix it points at.
        portRedirect: Boolean(captive?.listening && captive.fallback),
        // The control key, shown the same way and for the same reason as the
        // event PIN: it is minted silently on first use, and a key nobody
        // can find is a feature nobody has. Behind the admin password, and
        // it grants far less than that password does — see control.ts.
        controlKey: controlKey(store),
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
      // Present only when the box was asked to watch (CREWBOX_WATCH=1):
      // unlike lighting, this panel is opt-in and invisible until then, so
      // an audio-less rig never carries an empty section.
      ...(netwatch
        ? {
            media: mediaReadiness(
              netwatch.snapshot(),
              netwatch.ptp.status(Date.now()),
              netwatch.mdns.roster(),
              netwatch.sap.roster(),
              Date.now(),
              // A roster at its cap is a misbehaving network, and the list
              // stops being the answer to "what is out there".
              { devices: netwatch.mdns.overflow(), streams: netwatch.sap.overflow() }
            ),
          }
        : {}),
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

export interface WsHandles {
  /** The chat server. The hub is already attached to it. */
  wss: WebSocketServer
  /**
   * Terminate every upgraded socket — chat, docs relay and voice proxy.
   *
   * `http.Server.closeAllConnections()` does not do this. It only destroys
   * connections the HTTP parser still owns, and a socket handed to
   * `handleUpgrade` has been detached from that list — so `close()` then
   * waits for phones that are never going to hang up. Anything that needs
   * the port back has to say so first.
   *
   * Deliberately not `hub.close()` / `docs.close()`: those also stop the
   * heartbeats, and the port is released on a path (an update) that may hand
   * it straight back. This severs the sockets and leaves the box able to
   * serve again the moment it is listening.
   */
  terminateUpgraded: () => void
}

/** Wire the /ws (chat) and /ws/docs/<room> (shared docs) upgrade paths. */
export function attachWs(app: App): WsHandles {
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
    // Parsed inside a guard, because this is the first thing an unauthenticated
    // packet reaches and `new URL` is stricter than the HTTP parser that got us
    // here. Node accepts an absolute-form request target — `GET http://[
    // HTTP/1.1` is a valid enough request line for it — and WHATWG URL throws
    // on it. Thrown from inside a socket's data callback there is nothing above
    // to catch it: one packet, no token, and the box is gone in the middle of a
    // show. The loopback mirror re-emits this same event, so it was two ways in
    // rather than one.
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      socket.destroy()
      return
    }
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
  return {
    wss,
    terminateUpgraded: () => {
      for (const server of [wss, docsWss, voiceWss]) {
        for (const ws of server.clients) ws.terminate()
      }
    },
  }
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
