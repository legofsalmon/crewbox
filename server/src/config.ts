import { resolve } from 'node:path'

/** Parse a positive-integer day count, falling back to `fallback` on junk/≤0. */
function positiveDays(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
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
