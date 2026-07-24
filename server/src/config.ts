import { resolve } from 'node:path'

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  // Deliberately not the generic PORT — dev harnesses set that for the web app.
  port: Number(process.env.INTER_PORT ?? 8787),
  dataDir: resolve(process.env.DATA_DIR ?? './data'),
  /** Shared PIN printed on the QR join posters. Set EVENT_PIN in production. */
  eventPin: process.env.EVENT_PIN ?? '1234',
  /** Initial Wi-Fi SSID shown as join guidance; admins can override at runtime. */
  wifiSsid: process.env.WIFI_SSID ?? '',
  /** Built web app to serve in production (ignored if missing, e.g. in dev). */
  webDist: resolve(process.env.WEB_DIST ?? '../web/dist'),
  /**
   * Sessions idle longer than this stop working. Generous by default — a
   * crew phone that sat in a drawer between events must not be locked out
   * mid-festival — but finite, which matters once a tunnel exposes the
   * server to the internet.
   */
  sessionTtlMs: Number(process.env.SESSION_TTL_DAYS ?? 60) * 24 * 60 * 60 * 1000,
  /**
   * Behind cloudflared/Caddy: trust X-Forwarded-For so rate limits key on
   * the real client IP instead of lumping all proxied traffic together.
   */
  trustProxy: process.env.INTER_TRUST_PROXY === '1',
  /** LiveKit SFU for push-to-talk voice. Defaults match `livekit-server --dev`. */
  livekit: {
    /** URL the *client* uses to reach LiveKit. Empty string disables voice. */
    url: process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
    key: process.env.LIVEKIT_KEY ?? 'devkey',
    secret: process.env.LIVEKIT_SECRET ?? 'secret',
  },
}

export function warnOnDefaults(log: { warn: (msg: string) => void }) {
  if (!process.env.EVENT_PIN) {
    log.warn('EVENT_PIN not set — using default dev PIN "1234". Set EVENT_PIN in production!')
  }
}
