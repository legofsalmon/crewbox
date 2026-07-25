import { join } from 'node:path'
import { HOME_CHANNEL } from '@crewbox/shared'
import { existsSync, mkdirSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { config, warnOnDefaults } from './config.ts'
import { openDb } from './db.ts'
import { Store } from './store.ts'
import { attachWs, buildApp } from './app.ts'
import { boxDataDir, extractWebDist, isBox, openBrowser, printBoxBanner } from './box.ts'
import { hasEmbeddedLiveKit, livekitCredentials, startEmbeddedLiveKit } from './livekit.ts'

// No top-level await: the single-binary build bundles this entry as CJS
// (Node SEA requires a CommonJS main), so startup lives in an async main().
async function main(): Promise<void> {
  // Single-binary box: data lives with the user, the web bundle ships inside
  // the binary, and voice stays off unless explicitly configured.
  const box = isBox()
  const dataDir = box && !process.env.DATA_DIR ? boxDataDir() : config.dataDir
  mkdirSync(dataDir, { recursive: true })
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

  const app = buildApp({
    store,
    eventPin: config.eventPin,
    wifiSsid: config.wifiSsid,
    filesDir: join(dataDir, 'files'),
    livekit,
    sessionTtlMs: config.sessionTtlMs,
    trustProxy: config.trustProxy,
    modules: config.modules,
    dataDir,
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

  app.log.info(`crewbox server listening on ${config.host}:${config.port}`)
  app.log.info(`crew onboarding page: http://localhost:${config.port}/connect (QR, PIN, APK)`)
  if (box) {
    printBoxBanner(config.port, store.getSetting('eventPin') ?? config.eventPin)
    openBrowser(`http://localhost:${config.port}/connect`)
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      app.log.info(`${signal} received, shutting down`)
      // Belt and braces: if anything hangs, exit anyway so the supervisor
      // (systemd/tsx watch) can start a fresh process.
      setTimeout(() => process.exit(1), 3000).unref()
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
