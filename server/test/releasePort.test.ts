import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { attachWs, buildApp, type App, type WsHandles } from '../src/app.ts'

/**
 * Letting go of the port, with crew connected.
 *
 * This is the step an in-app update takes after it has already swapped the
 * binary, so a release that never returns is not a slow update — it is a box
 * that has stopped answering and cannot go back. The shipped implementation
 * was `closeAllConnections()` then `close()`, which reads as if it covers
 * every socket and does not: `closeAllConnections` only destroys connections
 * the HTTP parser still owns, and every WebSocket has been detached from that
 * list by `handleUpgrade`. One phone on the chat socket was enough to hang it
 * for ever.
 *
 * The test therefore holds a real upgraded socket open and asserts the
 * release finishes anyway — with a timeout, because the failure mode being
 * guarded is "never resolves", and a test that hangs proves nothing.
 */

let app: App
let ws: WsHandles
let db: DatabaseSync
let dir: string
let port: number
let clients: WebSocket[]

/** Fail loudly rather than hanging the suite when the release never returns. */
const within = async (ms: number, work: Promise<unknown>, what: string): Promise<void> => {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms)
  })
  try {
    await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The release the updater performs, as index.ts wires it. */
const release = async (): Promise<void> => {
  ws.terminateUpgraded()
  await new Promise<void>((resolve, reject) => {
    app.server.closeAllConnections()
    app.server.close((err) => (err ? reject(err) : resolve()))
  })
}

const joinUser = async (name: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, eventPin: '9999', personalPin: '4321' },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { token: string }).token
}

const openSocket = async (path: string): Promise<WebSocket> => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  clients.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-release-'))
  db = openDb(join(dir, 'test.db'))
  app = buildApp({
    store: new Store(db),
    eventPin: '9999',
    adminPassword: 'release-admin-pass',
    filesDir: dir,
    dataDir: dir,
    modules: ['chat', 'patch'],
    logger: false,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  ws = attachWs(app)
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  clients = []
})

afterEach(async () => {
  for (const socket of clients) socket.terminate()
  await app.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('releasing the port for an update', () => {
  it('finishes while a phone holds the chat socket', async () => {
    const token = await joinUser('Release Chat')
    const socket = await openSocket('/ws')
    socket.send(JSON.stringify({ type: 'hello', token, cursors: {} }))
    const first = await new Promise<string>((resolve) =>
      socket.once('message', (data: Buffer) => resolve(String(data)))
    )
    expect((JSON.parse(first) as { type: string }).type).toBe('welcome')

    await within(2000, release(), 'release with a chat socket open')
    expect(app.server.listening).toBe(false)
  })

  it('finishes while a phone holds a docs socket', async () => {
    const token = await joinUser('Release Docs')
    await openSocket(`/ws/docs/patch%2Fsheet-1?token=${encodeURIComponent(token)}`)

    await within(2000, release(), 'release with a docs socket open')
    expect(app.server.listening).toBe(false)
  })

  it('finishes with several sockets of both kinds open', async () => {
    const token = await joinUser('Release Both')
    await openSocket('/ws')
    await openSocket('/ws')
    await openSocket(`/ws/docs/patch%2Fsheet-1?token=${encodeURIComponent(token)}`)
    await openSocket(`/ws/docs/patch%2Fsheet-2?token=${encodeURIComponent(token)}`)

    await within(2000, release(), 'release with four sockets open')
    expect(app.server.listening).toBe(false)
  })

  it('hands the port back, so a rollback can start answering again', async () => {
    const token = await joinUser('Release Regain')
    await openSocket('/ws')
    await openSocket(`/ws/docs/patch%2Fsheet-1?token=${encodeURIComponent(token)}`)
    await within(2000, release(), 'release before regain')

    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject)
      app.server.listen({ host: '127.0.0.1', port }, () => resolve())
    })
    expect(app.server.listening).toBe(true)

    // And it is really serving, not merely bound.
    const health = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(health.status).toBe(200)
  })

  it('terminating leaves the clients closed rather than half-open', async () => {
    const socket = await openSocket('/ws')
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    await within(2000, release(), 'release')
    await within(2000, closed, 'the client seeing its socket close')
    expect(socket.readyState).toBe(WebSocket.CLOSED)
  })
})
