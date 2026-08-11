import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { attachWs, buildApp, type App } from '../src/app.ts'
import { parseRoomName } from '../src/docs.ts'

/**
 * Shared-docs relay integration: the real server, the real y-websocket v3
 * client (the one the web app will use), real sockets. Proves session-token
 * auth on the upgrade, module-namespace enforcement, two-client convergence,
 * presence, and room teardown.
 */

let dir: string
let app: App
let wsBase: string
let token: string

async function joinUser(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, eventPin: '9999', personalPin: '1234' },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { token: string }).token
}

function provider(room: string, doc: Y.Doc, tok: string): WebsocketProvider {
  return new WebsocketProvider(`${wsBase}/ws/docs`, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    params: { token: tok },
    disableBc: true,
  })
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-docs-test-'))
  const db = openDb(join(dir, 'crewbox.db'))
  const store = new Store(db)
  store.createChannel('general', 'public', '')
  app = buildApp({ store, eventPin: '9999', modules: ['chat', 'patch'], logger: false })
  await app.listen({ port: 0, host: '127.0.0.1' })
  attachWs(app)
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  wsBase = `ws://127.0.0.1:${port}`
  token = await joinUser('Docs Tester')
})

afterAll(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('docs relay auth', () => {
  it('rejects an upgrade without a valid session token', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws/docs/patch/sheet-x?token=not-a-session`)
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0)
        ws.terminate()
      })
      ws.on('open', () => reject(new Error('upgrade should have been rejected')))
      ws.on('error', () => {})
    })
    expect(status).toBe(401)
  })

  it('rejects a room outside an enabled module namespace', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws/docs/lighting/plot-1?token=${token}`)
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0)
        ws.terminate()
      })
      ws.on('open', () => reject(new Error('upgrade should have been rejected')))
      ws.on('error', () => {})
    })
    expect(status).toBe(403)
  })

  it('validates room names against the namespace grammar', () => {
    const enabled = ['chat', 'patch']
    expect(parseRoomName('patch/sheet-abc', enabled)).toBe('patch/sheet-abc')
    expect(parseRoomName('patch/index', enabled)).toBe('patch/index')
    expect(parseRoomName('lighting/plot', enabled)).toBeNull()
    expect(parseRoomName('patch', enabled)).toBeNull()
    expect(parseRoomName('patch/', enabled)).toBeNull()
    expect(parseRoomName('patch/a/b', enabled)).toBeNull()
    expect(parseRoomName('../etc/passwd', enabled)).toBeNull()
  })

  it('always allows the shell namespaces, whatever the box enables', () => {
    // The timetable is the event's, not a department's. A box running
    // chat-only still has a running order, and every module that reads it
    // would break if turning one module off took it away.
    expect(parseRoomName('timetable/event', ['chat'])).toBe('timetable/event')
    expect(parseRoomName('timetable/event', [])).toBe('timetable/event')
  })

  it('does not let a shell namespace become a wildcard', () => {
    // Always-allowed is not the same as unscoped: the room still has to be
    // shaped like a room, and nothing else gets in on the strength of it.
    expect(parseRoomName('timetable', [])).toBeNull()
    expect(parseRoomName('timetable/', [])).toBeNull()
    expect(parseRoomName('timetable/a/b', [])).toBeNull()
    expect(parseRoomName('timetables/event', [])).toBeNull()
  })
})

describe('docs relay sync', () => {
  it('converges two clients on one doc, both directions', async () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    // A has offline-created state before either client connects.
    docA.getMap('meta').set('title', 'Main Stage')

    const provA = provider('patch/sheet-sync', docA, token)
    const provB = provider('patch/sheet-sync', docB, token)
    try {
      await waitFor(() => docB.getMap('meta').get('title') === 'Main Stage')
      docB.getMap('meta').set('stage', 'A')
      await waitFor(() => docA.getMap('meta').get('stage') === 'A')

      const health = (await app.inject({ url: '/api/health' })).json() as {
        docs: { rooms: number; connections: number }
      }
      expect(health.docs.rooms).toBe(1)
      expect(health.docs.connections).toBe(2)
    } finally {
      provA.destroy()
      provB.destroy()
    }
  })

  it('propagates presence and clears it when a client drops', async () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const provA = provider('patch/sheet-presence', docA, token)
    const provB = provider('patch/sheet-presence', docB, token)
    try {
      provA.awareness.setLocalStateField('user', { name: 'Docs Tester' })
      await waitFor(() =>
        [...provB.awareness.getStates().values()].some(
          (s) => (s as { user?: { name?: string } }).user?.name === 'Docs Tester'
        )
      )
      provA.destroy()
      await waitFor(
        () =>
          ![...provB.awareness.getStates().values()].some(
            (s) => (s as { user?: { name?: string } }).user?.name === 'Docs Tester'
          )
      )
    } finally {
      provB.destroy()
    }
  })

  it('frees a room when the last client leaves (clients hold the durable copy)', async () => {
    const doc = new Y.Doc()
    doc.getMap('meta').set('title', 'Ephemeral')
    const prov = provider('patch/sheet-ephemeral', doc, token)
    await waitFor(() => prov.synced)
    prov.destroy()
    await waitFor(() => {
      const { rooms } = app.docs.stats()
      return rooms === 0
    })
    // Same room, fresh doc: server has nothing (the client would re-seed).
    const doc2 = new Y.Doc()
    const prov2 = provider('patch/sheet-ephemeral', doc2, token)
    await waitFor(() => prov2.synced)
    expect(doc2.getMap('meta').get('title')).toBeUndefined()
    prov2.destroy()
  })
})
