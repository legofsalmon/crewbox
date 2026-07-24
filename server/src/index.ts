import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { config, warnOnDefaults } from './config.ts'
import { openDb } from './db.ts'
import { Store } from './store.ts'
import { attachWs, buildApp } from './app.ts'

const db = openDb(join(config.dataDir, 'inter.db'))
const store = new Store(db)

// #general always exists so there is somewhere to land after joining.
if (!store.getChannelByName('general')) {
  store.createChannel('general', 'public', 'Everyone, everything')
}

const app = buildApp({
  store,
  eventPin: config.eventPin,
  wifiSsid: config.wifiSsid,
  filesDir: join(config.dataDir, 'files'),
  livekit: config.livekit,
  sessionTtlMs: config.sessionTtlMs,
  trustProxy: config.trustProxy,
})
const hub = app.hub

warnOnDefaults(app.log)

const webIndex = join(config.webDist, 'index.html')
if (existsSync(webIndex)) {
  const fastifyStatic = (await import('@fastify/static')).default
  await app.register(fastifyStatic, { root: config.webDist })
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api')) {
      return reply.sendFile('index.html')
    }
    return reply.code(404).send({ error: 'not found' })
  })
}

await app.listen({ host: config.host, port: config.port })
attachWs(app)

app.log.info(`inter server listening on ${config.host}:${config.port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`)
    // Belt and braces: if anything hangs, exit anyway so the supervisor
    // (systemd/tsx watch) can start a fresh process.
    setTimeout(() => process.exit(1), 3000).unref()
    hub.close()
    await app.close()
    db.close()
    process.exit(0)
  })
}
