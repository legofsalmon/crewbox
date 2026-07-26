import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { attachWs, buildApp, type App } from '../src/app.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { CERT_FILE, KEY_FILE, loadTls } from '../src/tls.ts'

/**
 * The two halves of "the box serves HTTPS itself": that it actually does,
 * and that voice still works once it does.
 *
 * The second half is the one worth the machinery. A page on https:// cannot
 * open a ws:// socket, so the moment a box gets a certificate, pointing crew
 * straight at the SFU would break voice for every browser — silently, and
 * only for the deployments that did the most setup.
 */

const dirs: string[] = []
const apps: App[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const server of servers.splice(0)) await new Promise((r) => server.close(() => r(null)))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'crewbox-https-'))
  dirs.push(dir)
  return dir
}

const makeCert = (dir: string) =>
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, KEY_FILE),
      '-out',
      join(dir, CERT_FILE),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' }
  )

const newApp = (deps: Partial<Parameters<typeof buildApp>[0]> = {}) => {
  const app = buildApp({
    store: new Store(openDb(':memory:')),
    eventPin: '1234',
    logger: false,
    ...deps,
  })
  apps.push(app)
  return app
}

describe('serving HTTPS', () => {
  it('answers over TLS when a certificate is in the data directory', async () => {
    const dir = tempDir()
    makeCert(dir)
    const { tls } = loadTls(dir)
    expect(tls).not.toBeNull()

    const app = newApp({ tls: tls!, dataDir: dir })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = (app.server.address() as { port: number }).port

    // node:https rather than fetch: fetch has no dependable per-request TLS
    // opt-out, and a test that can pass two different ways proves neither.
    // Self-signed here, so trust is off — what's under test is that the
    // socket speaks TLS at all.
    const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpsRequest(
        { host: '127.0.0.1', port, path: '/api/health', rejectUnauthorized: false },
        (res) => {
          let text = ''
          res.on('data', (chunk) => (text += String(chunk)))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
        }
      )
      req.on('error', reject)
      req.end()
    })

    expect(body.status).toBe(200)
    expect(JSON.parse(body.text)).toMatchObject({ ok: true })
  })

  it('serves plain HTTP when there is no certificate', async () => {
    const app = newApp({ dataDir: tempDir() })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = (app.server.address() as { port: number }).port

    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(res.status).toBe(200)
  })
})

describe('voice signalling proxy', () => {
  /** Stands in for livekit-server: echoes frames back with a marker. */
  const stubSfu = async (): Promise<number> => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ path: req.url }))
    })
    const wss = new WebSocketServer({ server })
    wss.on('connection', (ws, req) => {
      ws.send(`hello ${req.url}`)
      ws.on('message', (data: Buffer) => ws.send(`echo:${data.toString()}`))
    })
    servers.push(server)
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)))
    return (server.address() as { port: number }).port
  }

  it('pipes signalling frames both ways, stripping the proxy prefix', async () => {
    const sfuPort = await stubSfu()
    const app = newApp({
      livekit: { url: '', key: 'k', secret: 's', embedded: true, port: sfuPort },
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    attachWs(app)
    const port = (app.server.address() as { port: number }).port

    const client = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc?access_token=abc`)
    const frames: string[] = []
    await new Promise<void>((resolve, reject) => {
      client.on('message', (data: Buffer) => {
        frames.push(data.toString())
        if (frames.length === 2) resolve()
      })
      client.on('open', () => client.send('ping'))
      client.on('error', reject)
      setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(frames)}`)), 8000)
    })
    client.close()

    // The SFU must see /rtc, not /livekit/rtc, and the query has to survive —
    // it carries the access token.
    expect(frames[0]).toBe('hello /rtc?access_token=abc')
    expect(frames[1]).toBe('echo:ping')
  }, 15_000)

  it('proxies the HTTP preflight the SDK makes before connecting', async () => {
    const sfuPort = await stubSfu()
    const app = newApp({
      livekit: { url: '', key: 'k', secret: 's', embedded: true, port: sfuPort },
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = (app.server.address() as { port: number }).port

    const res = await fetch(`http://127.0.0.1:${port}/livekit/rtc/validate?x=1`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: '/rtc/validate?x=1' })
  })

  it('refuses the upgrade when the box runs no voice server', async () => {
    const app = newApp({})
    await app.listen({ host: '127.0.0.1', port: 0 })
    attachWs(app)
    const port = (app.server.address() as { port: number }).port

    const client = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc`)
    const error = await new Promise<Error>((resolve) => {
      client.on('error', resolve)
      client.on('open', () => resolve(new Error('unexpectedly connected')))
    })
    expect(error.message).not.toContain('unexpectedly')
  }, 10_000)
})
