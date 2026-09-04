import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { attachWs, buildApp, type App } from '../src/app.ts'

/**
 * The voice proxy, against a stub SFU.
 *
 * Signalling is relayed through the box's own port so that one certificate
 * covers everything (see voiceProxy.ts). That relay had no tests, and it is
 * exactly the layer a real MacBook failed in: "could not establish signal
 * connection: Websocket got closed during a (re)connection attempt", with the
 * HTTP half of the same proxy plainly working — the SDK's `/rtc/validate`
 * call got through first.
 *
 * The stub is a bare WebSocket server, not LiveKit. That is enough to tell a
 * broken relay from a broken SFU, which is the question.
 */

let app: App
let db: DatabaseSync
let store: Store
let filesDir: string
let sfu: WebSocketServer
let sfuPort: number
/** Every path the stub was asked for, so a mangled URL is visible. */
let sfuPaths: string[]
let sfuSockets: WebSocket[]
let sfuHttp: Server
/** What the stub was asked over HTTP, so a drained body is visible. */
let sfuBodies: { method: string; path: string; body: string }[]
let clients: WebSocket[]

const openStub = async (): Promise<void> => {
  sfuPaths = []
  sfuSockets = []
  sfuBodies = []
  // A real HTTP server under the WebSocket one: the SDK's `/rtc/validate`
  // and its POSTs go over HTTP through the same proxy, and a bare
  // WebSocketServer answers none of them.
  sfuHttp = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      sfuBodies.push({
        method: req.method ?? '',
        path: req.url ?? '',
        body: Buffer.concat(chunks).toString(),
      })
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('success')
    })
  })
  sfu = new WebSocketServer({ server: sfuHttp })
  await new Promise<void>((resolve) => sfuHttp.listen(0, '127.0.0.1', resolve))
  const address = sfuHttp.address()
  sfuPort = typeof address === 'object' && address ? address.port : 0
  sfu.on('connection', (ws, req) => {
    sfuPaths.push(req.url ?? '')
    sfuSockets.push(ws)
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      // Answer in kind, so the test can tell text from binary round trips.
      ws.send(isBinary ? Buffer.concat([Buffer.from([0xff]), data]) : `echo:${String(data)}`)
    })
  })
}

beforeEach(async () => {
  filesDir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-voiceproxy-'))
  db = openDb(pathJoin(filesDir, 'test.db'))
  store = new Store(db)
  clients = []
  await openStub()

  app = buildApp({
    store,
    eventPin: '9999',
    adminPassword: 'proxy-admin-pass',
    filesDir,
    dataDir: filesDir,
    // The embedded shape: no explicit url, so voiceUrl() hands clients the
    // box's own origin and the upgrade lands on the proxy.
    livekit: { url: '', embedded: true, port: sfuPort, key: 'devkey', secret: 'secret' },
    logger: false,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  attachWs(app)
})

afterEach(async () => {
  for (const ws of clients) ws.close()
  await app.close()
  await new Promise<void>((resolve) => sfu.close(() => resolve()))
  await new Promise<void>((resolve) => sfuHttp.close(() => resolve()))
  db.close()
  rmSync(filesDir, { recursive: true, force: true })
})

const appPort = (): number => {
  const address = app.server.address()
  return typeof address === 'object' && address ? address.port : 0
}

/** Open a client socket through the proxy and wait for it to be up. */
const connect = async (path: string): Promise<WebSocket> => {
  const ws = new WebSocket(`ws://127.0.0.1:${appPort()}${path}`)
  clients.push(ws)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
    ws.once('close', (code) => reject(new Error(`closed before open, code ${code}`)))
  })
  return ws
}

// Keeps the raw bytes as well as the text: reading a binary frame back
// through toString() mangles anything outside ASCII into U+FFFD, which cost
// one confusing red run.
const nextMessage = (
  ws: WebSocket,
  timeoutMs = 2000
): Promise<{ text: string; bytes: Buffer; binary: boolean }> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no frame arrived')), timeoutMs)
    ws.once('message', (data: Buffer, isBinary: boolean) => {
      clearTimeout(timer)
      resolve({ text: data.toString(), bytes: Buffer.from(data), binary: isBinary })
    })
  })

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

describe('signalling reaches the SFU', () => {
  it('upgrades and relays a frame each way', async () => {
    const ws = await connect('/livekit/rtc?access_token=abc123')
    ws.send('hello')
    expect((await nextMessage(ws)).text).toBe('echo:hello')
  })

  it('hands the SFU the path with the prefix stripped and the query kept', async () => {
    // The access token rides in the query string. Losing it turns a working
    // join into an authentication failure that looks like a network fault.
    await connect('/livekit/rtc?access_token=abc123&auto_subscribe=1')
    await settle()
    expect(sfuPaths).toEqual(['/rtc?access_token=abc123&auto_subscribe=1'])
  })

  it('relays binary frames as binary', async () => {
    // LiveKit signalling is protobuf. A binary frame arriving as text is a
    // corrupted join.
    const ws = await connect('/livekit/rtc?access_token=abc123')
    ws.send(Buffer.from([0x01, 0x02, 0x03]))
    const reply = await nextMessage(ws)
    expect(reply.binary).toBe(true)
    expect([...reply.bytes]).toEqual([0xff, 0x01, 0x02, 0x03])
  })

  it('does not lose frames sent before the upstream handshake finishes', async () => {
    // The client is told the socket is open as soon as the box accepts it,
    // which is before the box has finished connecting to the SFU. A frame in
    // that window is the join request itself.
    const ws = new WebSocket(`ws://127.0.0.1:${appPort()}/livekit/rtc?access_token=abc123`)
    clients.push(ws)
    ws.on('open', () => ws.send('early'))
    expect((await nextMessage(ws, 3000)).text).toBe('echo:early')
  })

  it('relays on the bare proxy path as well as under it', async () => {
    await connect('/livekit?access_token=abc123')
    await settle()
    expect(sfuPaths).toEqual(['/?access_token=abc123'])
  })
})

describe('when the SFU is not there', () => {
  it('closes the client rather than leaving it hanging', async () => {
    // What the MacBook saw. Worth pinning the *shape* of the failure: the
    // client is accepted and then dropped, which is why the browser reports a
    // socket closed mid-connection rather than a refused one.
    await new Promise<void>((resolve) => sfu.close(() => resolve()))
    const ws = new WebSocket(`ws://127.0.0.1:${appPort()}/livekit/rtc?access_token=abc123`)
    clients.push(ws)
    const outcome = await new Promise<string>((resolve) => {
      ws.once('close', () => resolve('closed'))
      ws.once('error', () => resolve('error'))
      setTimeout(() => resolve('hung'), 3000)
    })
    expect(outcome).not.toBe('hung')
    // Reopened so afterEach's close has something to close.
    await openStub()
  })
})

describe('when this box runs no SFU', () => {
  it('refuses the upgrade instead of accepting and dropping it', async () => {
    // A box with voice off should not accept a socket it can never serve.
    const bare = buildApp({
      store,
      eventPin: '9999',
      adminPassword: 'proxy-admin-pass',
      filesDir,
      dataDir: filesDir,
      logger: false,
    })
    await bare.listen({ host: '127.0.0.1', port: 0 })
    attachWs(bare)
    const address = bare.server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc?access_token=abc123`)
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('opened'))
      ws.once('error', () => resolve('refused'))
      setTimeout(() => resolve('hung'), 3000)
    })
    expect(outcome).toBe('refused')
    await bare.close()
  })
})

/**
 * The HTTP half of the same proxy.
 *
 * The SDK talks to `/rtc/validate` over HTTP before it opens a socket, and
 * publishes over HTTP after. Both went through a route Fastify had already
 * parsed the body of, so a JSON POST reached `req.pipe(target)` with nothing
 * left to send and hung upstream until it timed out — and anything Fastify
 * had no parser for was answered 415 before the proxy saw it.
 */
describe('proxying the SFU over HTTP', () => {
  const proxied = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${appPort()}${path}`, init)

  it('carries a GET through and hands back what the SFU said', async () => {
    const res = await proxied('/livekit/rtc/validate?access_token=abc123')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('success')
    expect(sfuBodies.at(-1)?.path).toBe('/rtc/validate?access_token=abc123')
  })

  it('carries a JSON POST through with its body intact', async () => {
    const res = await proxied('/livekit/twirp/livekit.RoomService/ListRooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names: ['general'] }),
    })
    expect(res.status).toBe(200)
    const seen = sfuBodies.at(-1)!
    expect(seen.method).toBe('POST')
    // The body arrived — it used to be drained by Fastify before the proxy
    // ever saw the request, and the upstream call hung with nothing to read.
    expect(JSON.parse(seen.body)).toEqual({ names: ['general'] })
  })

  it('carries a content type Fastify has no parser for', async () => {
    const res = await proxied('/livekit/twirp/livekit.RoomService/ListRooms', {
      method: 'POST',
      headers: { 'content-type': 'application/protobuf' },
      body: 'not-json-at-all',
    })
    // 415 was the old answer, decided before the proxy was reached.
    expect(res.status).toBe(200)
    expect(sfuBodies.at(-1)?.body).toBe('not-json-at-all')
  })
})
