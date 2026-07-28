import { join } from 'node:path'
import { HOME_CHANNEL } from '@crewbox/shared'
import { existsSync, mkdirSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { config, warnOnDefaults } from './config.ts'
import { attachWs, buildApp } from './app.ts'
import {
  boxDataDir,
  clearBoxStatus,
  extractWebDist,
  isBox,
  lanUrls,
  openBrowser,
  printBoxBanner,
  printBoxStatus,
  startTrayHelper,
  stopRunningBox,
  writeBoxStatus,
} from './box.ts'
import { hasEmbeddedLiveKit, livekitCredentials, startEmbeddedLiveKit } from './livekit.ts'
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

  // Voice. An explicit LIVEKIT_URL always wins — someone pointing at an SFU
  // they already run shouldn't have the box start a second one. Otherwise a
  // box build carrying the SFU starts it, and voice is simply on.
  let livekit: { url: string; key: string; secret: string; embedded?: boolean } = config.livekit
  let embedded: Awaited<ReturnType<typeof startEmbeddedLiveKit>> = null
  if (box && !process.env.LIVEKIT_URL) {
    if (hasEmbeddedLiveKit()) {
      const creds = livekitCredentials(
        (key) => store.getSetting(key),
        (key, value) => store.setSetting(key, value)
      )
      embedded = await startEmbeddedLiveKit({ dataDir, ...creds, log: console })
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

  const app = buildApp({
    store,
    eventPin: config.eventPin,
    wifiSsid: config.wifiSsid,
    ...(config.adminPassword ? { adminPassword: config.adminPassword } : {}),
    filesDir: join(dataDir, 'files'),
    livekit,
    sessionTtlMs: config.sessionTtlMs,
    trustProxy: config.trustProxy,
    modules: config.modules,
    dataDir,
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

  await app.listen({ host: config.host, port: config.port })
  attachWs(app)

  if (tlsReason) app.log.warn(`https: ${tlsReason} Serving plain HTTP.`)
  app.log.info(
    `crewbox server listening on ${config.host}:${config.port} (${tls ? 'https' : 'http'})`
  )
  const origin = `${tls ? 'https' : 'http'}://localhost:${config.port}`
  app.log.info(`crew onboarding page: ${origin}/connect (QR, PIN, APK)`)
  if (box) {
    // Nobody has joined yet means nobody has set this box up yet, so send the
    // admin to the three questions rather than to a QR for an unnamed event.
    // /setup redirects to /connect once anyone has joined, so a box that has
    // run before goes straight to the QR.
    // A Mac box that sleeps takes the whole crew's comms with it.
    preventSleep(app.log)
    const firstRun = store.countUsers() === 0
    const eventPin = store.getSetting('eventPin') ?? config.eventPin
    const eventName = store.getSetting('eventName') ?? ''
    printBoxBanner(config.port, eventPin, Boolean(tls), { eventName, firstRun })

    // Tell the menu-bar/tray helper what to show and, crucially, which
    // process to stop. Written after listen() so its presence means the box
    // is actually answering, not merely starting.
    const urls = lanUrls(config.port, Boolean(tls))
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

    openBrowser(`${origin}${firstRun ? '/setup' : '/connect'}`)
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
