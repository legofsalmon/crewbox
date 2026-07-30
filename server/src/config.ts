import { resolve } from 'node:path'
import { parseUniverseList, type DmxMode } from './dmx/listener.ts'

/** `CREWBOX_DMX`, defaulting to off — a box never listens unless asked. */
function dmxMode(value: string | undefined): DmxMode {
  return value === 'artnet' || value === 'sacn' || value === 'both' ? value : 'off'
}

/** Parse a positive-integer day count, falling back to `fallback` on junk/≤0. */
function positiveDays(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  /** Whether HOST was set by hand, in which case it outranks CREWBOX_IFACE. */
  hostExplicit: process.env.HOST !== undefined,
  /**
   * IP of the crew-facing network adapter (`CREWBOX_IFACE`).
   *
   * A festival box usually sits on two networks: the crew Wi-Fi and the
   * lighting VLAN (`CREWBOX_DMX_IFACE`, receive-only). Without this, every
   * advertised address — the join QR, the terminal banner, /connect — takes
   * the first adapter the OS enumerates, which on a two-network machine is a
   * coin flip; and the web server answers on every adapter, including the
   * lighting network's.
   *
   * Set, it decides both halves: the box binds its HTTP server to this
   * address (plus localhost) and advertises only it — so the crew-facing
   * product generates no traffic on the lighting network at all, not even
   * replies to a port scan.
   */
  iface: process.env.CREWBOX_IFACE?.trim() ?? '',
  // Deliberately not the generic PORT — dev harnesses set that for the web app.
  port: Number(process.env.CREWBOX_PORT ?? 8787),
  dataDir: resolve(process.env.DATA_DIR ?? './data'),
  /** Shared PIN printed on the QR join posters. Set EVENT_PIN in production. */
  eventPin: process.env.EVENT_PIN ?? '1234',
  /** Initial Wi-Fi SSID shown as join guidance; admins can override at runtime. */
  wifiSsid: process.env.WIFI_SSID ?? '',
  /**
   * Admin panel password. Unlike EVENT_PIN this is *not* on a poster, and
   * unlike EVENT_PIN setting it here overrides whatever the box has stored —
   * which makes it the documented way back in when the password is lost.
   * Leave unset and the box mints one on first start and prints it once.
   */
  adminPassword: process.env.ADMIN_PASSWORD,
  /** Built web app to serve in production (ignored if missing, e.g. in dev). */
  webDist: resolve(process.env.WEB_DIST ?? '../web/dist'),
  /**
   * Sessions idle longer than this stop working. Generous by default — a
   * crew phone that sat in a drawer between events must not be locked out
   * mid-festival — but finite, which matters once a tunnel exposes the
   * server to the internet. A malformed or non-positive value falls back to
   * the default rather than silently disabling expiry (NaN would read as
   * "never expire", the opposite of what an operator hardening a public
   * server intends).
   */
  sessionTtlMs: positiveDays(process.env.SESSION_TTL_DAYS, 60) * 24 * 60 * 60 * 1000,
  /**
   * Behind cloudflared/Caddy: trust X-Forwarded-For so rate limits key on
   * the real client IP instead of lumping all proxied traffic together.
   */
  trustProxy: process.env.CREWBOX_TRUST_PROXY === '1',
  /**
   * Module ids this box enables beyond chat (comma-separated). Chat is
   * always on. The default turns on every department module the build
   * ships, because one box is meant to serve the whole crew and an unused
   * module costs one collapsed sidebar row. Set CREWBOX_MODULES='' to run
   * chat-only, or name a subset to trim it.
   */
  modules: [
    ...new Set(
      ('chat,' + (process.env.CREWBOX_MODULES ?? 'patch,lighting'))
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    ),
  ],
  /**
   * Listening to a lighting network. Off unless asked for: a box that has not
   * been told to listen opens no sockets, and crewbox never transmits on one
   * either way (see server/src/dmx/listener.ts).
   */
  dmx: {
    mode: dmxMode(process.env.CREWBOX_DMX),
    /**
     * Interface to join sACN multicast groups on — **not** a bind address.
     * The socket always binds 0.0.0.0; binding it to a specific unicast
     * address stops multicast arriving at all on Linux. On a box with more
     * than one card this is effectively required, or the kernel picks by
     * routing table and may join on the wrong one and hear nothing.
     */
    interfaceIp: process.env.CREWBOX_DMX_IFACE || undefined,
    universes: parseUniverseList(process.env.CREWBOX_DMX_UNIVERSES ?? '1-16'),
    /**
     * Plot universe that Art-Net universe 0 corresponds to. Art-Net counts
     * from 0 and a plot counts from 1, and getting this wrong checks every
     * fixture against the wrong universe — 512 channels out, invisible on
     * paper and very visible on stage.
     */
    artnetBase: Number(process.env.CREWBOX_DMX_ARTNET_BASE ?? 1) || 0,
  },
  /** LiveKit SFU for push-to-talk voice. Defaults match `livekit-server --dev`. */
  livekit: {
    /**
     * URL the *client* uses to reach LiveKit. Empty string disables voice —
     * the voice button disappears rather than erroring. The localhost dev
     * default applies only outside production, so a box without LiveKit
     * doesn't advertise voice it can't deliver.
     */
    url:
      process.env.LIVEKIT_URL ??
      (process.env.NODE_ENV === 'production' ? '' : 'ws://localhost:7880'),
    key: process.env.LIVEKIT_KEY ?? 'devkey',
    secret: process.env.LIVEKIT_SECRET ?? 'secret',
  },
}

/**
 * Guard risky defaults at startup. Returns a fatal message when the config is
 * unsafe to run (caller should exit), or null. A tunnel-exposed server
 * (CREWBOX_TRUST_PROXY=1) running on the public default event PIN would let
 * anyone on the internet register — fail closed rather than warn.
 */
export function warnOnDefaults(
  log: { warn: (msg: string) => void },
  /** An admin-set PIN (settings table) overrides the default, so it's safe. */
  hasStoredPin = false
): string | null {
  if (!process.env.EVENT_PIN && !hasStoredPin) {
    if (config.trustProxy) {
      return 'EVENT_PIN is unset but CREWBOX_TRUST_PROXY=1 (internet-exposed). Refusing to start on the public default PIN — set EVENT_PIN (or set one in the admin panel first).'
    }
    log.warn('EVENT_PIN not set — using default dev PIN "1234". Set EVENT_PIN in production!')
  }
  return null
}
