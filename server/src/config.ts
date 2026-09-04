import { resolve } from 'node:path'
import { parseUniverseList, type DmxMode } from './dmx/listener.ts'

/** `CREWBOX_DMX`, defaulting to off — a box never listens unless asked. */
export function dmxMode(value: string | undefined): DmxMode {
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
      ('chat,' + (process.env.CREWBOX_MODULES ?? 'schedule,patch,lighting,incident,video,network'))
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
     * Which of these came from the environment. Settings saved in the admin
     * panel fill the gaps; an env var always wins, which keeps the terminal
     * the recovery path when a saved setting is wrong.
     */
    modeFromEnv: process.env.CREWBOX_DMX !== undefined,
    ifaceFromEnv: process.env.CREWBOX_DMX_IFACE !== undefined,
    universesFromEnv: process.env.CREWBOX_DMX_UNIVERSES !== undefined,
    /**
     * Interface to join sACN multicast groups on — **not** a bind address.
     * The socket always binds 0.0.0.0; binding it to a specific unicast
     * address stops multicast arriving at all on Linux. On a box with more
     * than one card this is effectively required, or the kernel picks by
     * routing table and may join on the wrong one and hear nothing.
     */
    interfaceIp: process.env.CREWBOX_DMX_IFACE || undefined,
    universes: parseUniverseList(process.env.CREWBOX_DMX_UNIVERSES ?? '1-16'),
    /** The list as typed, for "did the saved settings change" comparisons. */
    universesRaw: process.env.CREWBOX_DMX_UNIVERSES ?? '1-16',
    /**
     * Plot universe that Art-Net universe 0 corresponds to. Art-Net counts
     * from 0 and a plot counts from 1, and getting this wrong checks every
     * fixture against the wrong universe — 512 channels out, invisible on
     * paper and very visible on stage.
     */
    artnetBase: Number(process.env.CREWBOX_DMX_ARTNET_BASE ?? 1) || 0,
  },
  /**
   * Watching the audio/media network: PTP clock health, the Dante/NDI device
   * roster (mDNS), and the AES67 stream directory (SAP). Off unless asked,
   * and read-only however it is configured — the sockets it opens have had
   * `send` removed (server/src/netwatch/listener.ts), the same guarantee the
   * lighting listener makes.
   */
  watch: {
    enabled: process.env.CREWBOX_WATCH === '1',
    /**
     * Interface to join the multicast groups on — not a bind address, for
     * the same Linux reason as CREWBOX_DMX_IFACE. On a box with more than
     * one card this is effectively required.
     */
    interfaceIp: process.env.CREWBOX_WATCH_IFACE?.trim() || undefined,
  },
  /**
   * Asking whether a newer crewbox exists (server/src/update.ts).
   *
   * `enabled` undefined means "on for a box, off from source", the same rule
   * the captive responder follows and for the same reason: a packaged box in
   * a shed is the thing that benefits from being told, whereas `npm run dev`
   * on a laptop has no business calling GitHub.
   *
   * It asks and nothing more — no download, no install. Set
   * CREWBOX_UPDATE_CHECK=0 on a box whose network must make no outbound
   * connections at all; the panel then simply never mentions updates. The
   * request tells GitHub this box's IP and version and nothing else.
   */
  updateCheck:
    process.env.CREWBOX_UPDATE_CHECK === '1'
      ? true
      : process.env.CREWBOX_UPDATE_CHECK === '0'
        ? false
        : undefined,
  /**
   * Watching LED processors (the video module).
   *
   * There is no on/off switch here, and deliberately so: the module's resting
   * state is already silence. The box contacts a processor only after an admin
   * has confirmed that specific one twice, so "enabled" would gate nothing
   * that is not already gated.
   */
  video: {
    /**
     * IP of the video-network adapter (`CREWBOX_VIDEO_IFACE`).
     *
     * Needed only for the discovery scan, which sends to that segment's
     * broadcast address rather than 255.255.255.255 — a limited broadcast
     * leaves by whichever adapter the routing table picks, which on a box that
     * also holds the crew Wi-Fi means probing a network nobody asked about.
     * Unset, processors added by address are still read; only scanning is
     * unavailable, and the pane says why.
     */
    interfaceIp: process.env.CREWBOX_VIDEO_IFACE?.trim() || undefined,
    /**
     * SNMP read community. Not a secret — SNMPv2c has no encryption and
     * "public" is what COEX controllers ship with. Configurable because some
     * venues change it, and a venue that has will tell you what to.
     */
    community: process.env.CREWBOX_VIDEO_SNMP_COMMUNITY?.trim() || 'public',
  },
  /**
   * The OS connectivity-probe responder (server/src/captive.ts) — the thing
   * that stops an iPhone declaring the crew Wi-Fi dead and moving to
   * cellular, taking the box with it.
   *
   * `enabled` undefined means "on for a box, off from source": a packaged box
   * is on a crew network and should answer, whereas `npm run dev` on a laptop
   * has no business reaching for port 80. CREWBOX_CAPTIVE=1/0 decides
   * explicitly either way.
   *
   * On its own this listener changes nothing — probes only arrive if the
   * event router's DNS sends them here, which an admin pastes deliberately
   * (see the file /api/admin/dns-config generates).
   */
  /**
   * The timezone the festival is in (`CREWBOX_TZ`), as an IANA name.
   *
   * Unset, the box uses its own process timezone, which is right on a box
   * whose clock was set up on site. A box imaged with UTC and driven to a
   * field is not: it would tell a production desk the headliner is on an
   * hour from when every crew phone says, during the show. This is the one
   * place to say so once.
   */
  timeZone: process.env.CREWBOX_TZ?.trim() || undefined,

  captive: {
    enabled:
      process.env.CREWBOX_CAPTIVE === '1'
        ? true
        : process.env.CREWBOX_CAPTIVE === '0'
          ? false
          : undefined,
    /**
     * Port 80 is where the probes go, and it is privileged. Left unset, the
     * box tries 80 and drops to an unprivileged port when it may not have it
     * (see captive.ts) — the normal outcome on macOS. Set explicitly, it is
     * honoured exactly: whoever named a port has arranged for something to
     * reach it, and moving aside would break that silently.
     */
    port: Number(process.env.CREWBOX_CAPTIVE_PORT ?? 80) || 80,
    portFromEnv: process.env.CREWBOX_CAPTIVE_PORT !== undefined,
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
