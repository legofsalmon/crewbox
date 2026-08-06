import { join } from 'node:path'
import { HOME_CHANNEL } from '@crewbox/shared'
import { existsSync, mkdirSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { config, dmxMode, warnOnDefaults } from './config.ts'
import { attachWs, buildApp, mirrorOnLoopback } from './app.ts'
import { DmxListener, parseUniverseList } from './dmx/listener.ts'
import { NetWatch } from './netwatch/listener.ts'
import {
  advertisedUrls,
  boxDataDir,
  lanIps,
  clearBoxStatus,
  extractWebDist,
  isBox,
  openBrowser,
  portInUse,
  printBoxBanner,
  printBoxStatus,
  startTrayHelper,
  stopRunningBox,
  writeBoxStatus,
} from './box.ts'
import { certNames } from './environment.ts'
import {
  hasEmbeddedLiveKit,
  livekitCredentials,
  startEmbeddedLiveKit,
  type EmbeddedLiveKit,
  type SfuFailure,
} from './livekit.ts'
import { preventSleep } from './nosleep.ts'
import { loadTls } from './tls.ts'

// No top-level await: the single-binary build bundles this entry as CJS
// (Node SEA requires a CommonJS main), so startup lives in an async main().
async function main(): Promise<void> {
  // Single-binary box: data lives with the user, the web bundle ships inside
  // the binary, and voice stays off unless explicitly configured.
  const box = isBox()
  const dataDir = box && !process.env.DATA_DIR ? boxDataDir() : config.dataDir

  // Handled before anything opens the database or binds a port: these are
  // questions about a box that is already running, asked by a second process.
  //
  // `--stop` is the answer that works everywhere. The menu-bar item and the
  // tray icon are nicer, but a headless Linux box in a shed has neither, and
  // until now a double-clicked macOS app had no way to be stopped at all.
  const flag = process.argv.slice(2).find((arg) => arg === '--stop' || arg === '--status')
  if (flag === '--stop') process.exit(await stopRunningBox(dataDir))
  if (flag === '--status') process.exit(printBoxStatus(dataDir))

  mkdirSync(dataDir, { recursive: true })

  // Imported here rather than at the top so `--stop` and `--status` never
  // load node:sqlite — it prints an ExperimentalWarning on load, which is
  // three lines of noise beside a command whose whole output is one.
  const { openDb } = await import('./db.ts')
  const { Store } = await import('./store.ts')
  const webDist = box ? extractWebDist(dataDir) : config.webDist

  const db = openDb(join(dataDir, 'crewbox.db'))
  const store = new Store(db)

  // First boot of a box: mint a random event PIN instead of shipping "1234"
  // everywhere. It prints below, shows on /connect, and the admin can change
  // it any time from the panel.
  if (box && !process.env.EVENT_PIN && !store.getSetting('eventPin')) {
    store.setSetting('eventPin', String(randomInt(1000, 10000)))
  }

  // The home channel always exists so there is somewhere to land after joining.
  if (!store.getChannelByName(HOME_CHANNEL)) {
    store.createChannel(HOME_CHANNEL, 'public', 'Everyone, everything')
  }

  // Network settings resolve env-first, then whatever the admin saved in the
  // setup page or the panel — so a relaunch needs no terminal, and a bad
  // save is still recoverable by setting the env var. Resolved once, here:
  // everything below (SFU bind, web bind, DMX listener, banner) runs off
  // this one answer, and the panel compares its saved settings against it
  // to say when a restart is due.
  const saved = {
    crewIface: store.getSetting('crewIface') ?? '',
    dmxMode: store.getSetting('dmxMode') ?? '',
    dmxIface: store.getSetting('dmxIface') ?? '',
    dmxUniverses: store.getSetting('dmxUniverses') ?? '',
  }
  const boot = {
    iface: config.iface || saved.crewIface,
    dmxMode: config.dmx.modeFromEnv ? config.dmx.mode : dmxMode(saved.dmxMode || undefined),
    dmxIface: config.dmx.ifaceFromEnv ? (config.dmx.interfaceIp ?? '') : saved.dmxIface,
    dmxUniverses: config.dmx.universesFromEnv
      ? config.dmx.universesRaw
      : saved.dmxUniverses || '1-16',
  }

  // Whether the crew adapter is actually present. Decided once, up front,
  // because two things hang off it: which address the SFU binds below, and
  // which address the web server binds further down. A pinned address no
  // adapter has falls back to answering everywhere — a box that refuses to
  // start over a pulled cable is a crew with no comms — and the admin
  // panel's network check names the mismatch.
  const ifaceUp = Boolean(boot.iface) && lanIps().includes(boot.iface)
  if (boot.iface && !ifaceUp) {
    console.warn(
      `crew network is set to ${boot.iface} but no adapter has that address — answering on all adapters`
    )
  }

  // Which address to answer on. An explicit HOST always wins — someone who set
  // it knows what they want. Otherwise CREWBOX_IFACE binds the box to the crew
  // adapter, so a machine that also has a leg on the lighting VLAN answers
  // nothing there — not even a port scan. Decided here, before anything binds,
  // because the port pre-flight below and the real listen further down must
  // agree on the address.
  const bindHost = config.hostExplicit ? config.host : ifaceUp ? boot.iface : config.host

  // Refuse a second box before it does anything destructive. If this port is
  // already held, another crewbox owns this data directory — and its voice
  // server. Without this, the SFU reap in startEmbeddedLiveKit below would
  // kill *that* box's live SFU (taking voice down mid-show) and this start
  // would then die on the port bind regardless. Fail first, touch nothing.
  if (box && (await portInUse(bindHost, config.port))) {
    console.error(
      `port ${config.port} is already in use on ${bindHost} — a crewbox is already running ` +
        `here (stop it with: crewbox --stop), or something else holds the port. Not starting.`
    )
    process.exit(1)
  }

  // Voice. An explicit LIVEKIT_URL always wins — someone pointing at an SFU
  // they already run shouldn't have the box start a second one. Otherwise a
  // box build carrying the SFU starts it, and voice is simply on.
  let livekit: { url: string; key: string; secret: string; embedded?: boolean } = config.livekit
  let embedded: EmbeddedLiveKit | null = null
  let voiceFailure: SfuFailure | undefined
  if (box && !process.env.LIVEKIT_URL) {
    if (hasEmbeddedLiveKit()) {
      const creds = livekitCredentials(
        (key) => store.getSetting(key),
        (key, value) => store.setSetting(key, value)
      )
      const outcome = await startEmbeddedLiveKit({
        dataDir,
        ...creds,
        ...(ifaceUp ? { iface: boot.iface } : {}),
        log: console,
      })
      embedded = outcome.sfu
      // Carried into the admin panel: "voice is off" with no reason reads as
      // a build limitation, and the fix for a held port is nothing like the
      // fix for a missing binary.
      voiceFailure = outcome.failure
    }
    livekit = embedded
      ? { url: '', key: embedded.key, secret: embedded.secret, embedded: true }
      : { ...config.livekit, url: '' }
  }

  // A certificate in the data directory turns on HTTPS, and with it the
  // browser microphone and install-to-home-screen. Missing or broken
  // material never stops the box: it logs why and serves plain HTTP, which
  // is a working product minus those two things.
  const { tls, reason: tlsReason } = loadTls(dataDir)

  // Listening to the lighting network, when this box was asked to. Off by
  // default, and read-only however it is configured: the sockets it opens
  // have had `send` taken off them (server/src/dmx/listener.ts).
  const dmx =
    boot.dmxMode === 'off'
      ? undefined
      : new DmxListener({
          mode: boot.dmxMode,
          universes: parseUniverseList(boot.dmxUniverses),
          artnetBase: config.dmx.artnetBase,
          ...(boot.dmxIface ? { interfaceIp: boot.dmxIface } : {}),
        })

  // Watching the audio/media network (PTP clock, Dante/NDI rosters, AES67
  // streams), when asked. Same off-by-default posture and the same
  // structural read-only guarantee as the lighting listener.
  const netwatch = config.watch.enabled
    ? new NetWatch({
        ...(config.watch.interfaceIp ? { interfaceIp: config.watch.interfaceIp } : {}),
        log: console,
      })
    : undefined

  const app = buildApp({
    store,
    eventPin: config.eventPin,
    wifiSsid: config.wifiSsid,
    ...(config.adminPassword ? { adminPassword: config.adminPassword } : {}),
    filesDir: join(dataDir, 'files'),
    livekit,
    ...(voiceFailure ? { voiceFailure } : {}),
    sessionTtlMs: config.sessionTtlMs,
    trustProxy: config.trustProxy,
    modules: config.modules,
    dataDir,
    ...(config.iface ? { iface: config.iface } : {}),
    network: {
      boot,
      env: {
        iface: Boolean(config.iface),
        dmxMode: config.dmx.modeFromEnv,
        dmxIface: config.dmx.ifaceFromEnv,
        dmxUniverses: config.dmx.universesFromEnv,
      },
    },
    ...(dmx ? { dmx } : {}),
    ...(netwatch ? { netwatch } : {}),
    ...(tls ? { tls } : {}),
  })
  const hub = app.hub

  const fatal = warnOnDefaults(app.log, Boolean(store.getSetting('eventPin')))
  if (fatal) {
    app.log.error(fatal)
    process.exit(1)
  }

  const webIndex = join(webDist, 'index.html')
  if (existsSync(webIndex)) {
    const fastifyStatic = (await import('@fastify/static')).default
    await app.register(fastifyStatic, { root: webDist })
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'not found' })
    })
  }

  // Bind the address resolved up top (see bindHost, before the voice block).
  await app.listen({ host: bindHost, port: config.port })
  attachWs(app)

  // Bound to one adapter, the box would lose localhost — which is the mic
  // test, the health checks, and where a browser on the box itself goes. A
  // small mirror keeps it. See mirrorOnLoopback.
  let closeLoopback: (() => Promise<void>) | undefined
  if (ifaceUp && !config.hostExplicit) {
    try {
      closeLoopback = await mirrorOnLoopback(app, config.port)
    } catch (error) {
      app.log.warn(`localhost mirror did not start (${String(error)}); use ${config.iface} locally`)
    }
  }

  // After listen(), so a lighting network that refuses to open never stops
  // the box serving crew — it becomes a line in the admin panel instead.
  if (dmx) {
    dmx.start()
    app.log.info(`lighting network: listening (${boot.dmxMode})`)
  }
  if (netwatch) {
    netwatch.start()
    app.log.info('media network: watching (PTP clock, mDNS rosters, SAP streams)')
  }

  if (tlsReason) app.log.warn(`https: ${tlsReason} Serving plain HTTP.`)
  app.log.info(
    `crewbox server listening on ${config.host}:${config.port} (${tls ? 'https' : 'http'})`
  )
  // Where to send a browser. Plain HTTP: localhost, which always works on
  // the box itself. With a certificate, localhost stops being an option —
  // it fails the browser's name check against the certificate and gets the
  // full "not private" interstitial on the box's own screen — so the
  // certificate's name is the origin, everywhere the box speaks. Whether
  // that name resolves here yet is the environment panel's job to say.
  const certName = tls ? certNames(tls.cert.toString())[0] : undefined
  const origin = certName
    ? `https://${certName}:${config.port}`
    : `${tls ? 'https' : 'http'}://localhost:${config.port}`
  app.log.info(`crew onboarding page: ${origin}/connect (QR, PIN, APK)`)
  if (box) {
    // Nobody has joined yet means nobody has set this box up yet, so send the
    // admin to the three questions rather than to a QR for an unnamed event.
    // A box that has run before opens the app itself: whoever launches a
    // running box is almost always already crew, and `/` is the page that
    // adapts — the app when this browser holds a session, the join screen
    // when it doesn't. The QR poster page stays one step away (the banner
    // prints /connect, and the menu-bar helper links it) for the screens
    // whose job is showing the QR to everyone else.
    // A Mac box that sleeps takes the whole crew's comms with it.
    preventSleep(app.log)
    const firstRun = store.countUsers() === 0
    const eventPin = store.getSetting('eventPin') ?? config.eventPin
    const eventName = store.getSetting('eventName') ?? ''
    printBoxBanner(config.port, eventPin, Boolean(tls), {
      eventName,
      firstRun,
      iface: boot.iface,
      ...(certName ? { hostname: certName } : {}),
    })

    // Tell the menu-bar/tray helper what to show and, crucially, which
    // process to stop. Written after listen() so its presence means the box
    // is actually answering, not merely starting.
    const urls = advertisedUrls(config.port, Boolean(tls), {
      ...(certName ? { hostname: certName } : {}),
      iface: boot.iface,
    })
    writeBoxStatus(dataDir, {
      pid: process.pid,
      port: config.port,
      secure: Boolean(tls),
      joinUrl: urls[0] ?? origin,
      urls,
      eventPin,
      eventName,
      version: process.env.DEPLOY_VERSION ?? '',
    })

    // After the status file, which is the only thing it reads.
    startTrayHelper(dataDir)

    openBrowser(`${origin}${firstRun ? '/setup' : '/'}`)
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      app.log.info(`${signal} received, shutting down`)
      // Belt and braces: if anything hangs, exit anyway so the supervisor
      // (systemd/tsx watch) can start a fresh process.
      setTimeout(() => process.exit(1), 3000).unref()
      // First, so a helper watching this file stops offering to open a box
      // that is on its way down.
      if (box) clearBoxStatus(dataDir)
      hub.close()
      netwatch?.stop()
      await closeLoopback?.()
      await app.close()
      await embedded?.stop()
      db.close()
      process.exit(0)
    })
  }
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
