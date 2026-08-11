import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { attachWs, buildApp, type App } from '../src/app.ts'
import { controlKey, readRunningOrder, TIMETABLE_ROOM } from '../src/control.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'

/**
 * The desk's read of the box, over the wire it will be driven on.
 *
 * The running order half is the reason this is an integration test rather
 * than another unit one: the box does not keep a timetable of its own. It
 * reads the document the crew's phones are already syncing through it, which
 * means a real client, a real relay room, and a box that honestly knows
 * nothing when nobody is connected.
 *
 * The clock is injected, so "what is on the main stage at half nine" is a
 * question CI can ask at four in the morning.
 */

const EVENT_PIN = '9999'
/** Half nine on the Tuesday: mid-set on one stage, half an hour off on the other. */
const NOW = new Date(2026, 7, 11, 21, 30)

let dir: string
let store: Store
let app: App
let key: string
let wsBase: string
let phone: WebsocketProvider
let phoneDoc: Y.Doc

const seed = (doc: Y.Doc, acts: Record<string, unknown>[]): void => {
  const array = doc.getArray<Y.Map<unknown>>('acts')
  doc.transact(() => {
    for (const act of acts) {
      const map = new Y.Map<unknown>()
      for (const [field, value] of Object.entries(act)) map.set(field, value)
      array.push([map])
    }
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
  dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-control-'))
  store = new Store(openDb(pathJoin(dir, 'test.db')))
  store.createChannel('general', 'public', '')
  store.setSetting('eventName', 'Test Event')
  app = buildApp({
    store,
    eventPin: EVENT_PIN,
    dataDir: dir,
    logger: false,
    clock: () => NOW,
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  attachWs(app)
  const address = app.server.address()
  wsBase = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  key = controlKey(store, {})

  // A crew member with the app open — which is what puts the running order on
  // the box at all.
  const joined = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name: 'Desk Tester', eventPin: EVENT_PIN, personalPin: '1234' },
  })
  const token = (joined.json() as { token: string }).token

  phoneDoc = new Y.Doc()
  phone = new WebsocketProvider(`${wsBase}/ws/docs`, TIMETABLE_ROOM, phoneDoc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    params: { token },
    disableBc: true,
  })
  await waitFor(() => phone.synced)
  seed(phoneDoc, [
    { id: 'a1', name: 'Sound Check Kids', stage: 'Main Stage', start: '19:00', end: '20:00' },
    { id: 'a2', name: 'The Fixture', stage: 'Main Stage', start: '21:00', end: '22:30' },
    { id: 'a3', name: 'Backline', stage: 'Second Stage', start: '22:00', end: '23:00' },
  ])
  await waitFor(() => readRunningOrder(app.docs.peek(TIMETABLE_ROOM)).length === 3)
})

afterAll(async () => {
  phone.destroy()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

interface StateBody {
  event: string
  version: string
  onAir: { userId: string | null; name: string; since: number }
  crew: { online: number; total: number }
  voice: { enabled: boolean; quality: unknown }
  channels: { id: string; name: string }[]
  runningOrder: {
    known: boolean
    stages: {
      stage: string
      onNow: { name: string; ends: string } | null
      next: { name: string; starts: string; startsIn: number } | null
    }[]
  }
}

const state = async (query = ''): Promise<StateBody> => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/control/state${query}`,
    headers: { 'x-api-key': key },
  })
  expect(res.statusCode).toBe(200)
  return res.json() as StateBody
}

describe('what the desk may read', () => {
  it('turns away a request with no key', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/control/state' })).statusCode).toBe(401)
  })

  it('names the event and counts the crew', async () => {
    const body = await state()
    expect(body.event).toBe('Test Event')
    expect(body.crew.total).toBe(1)
    expect(body.version).toBeTruthy()
  })

  it('lists the channels a message button could post to', async () => {
    expect((await state()).channels.map((c) => c.name)).toContain('general')
  })

  it('says who is on air, by name as well as by id', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/control/tally',
      payload: { user: 'Desk Tester' },
      headers: { 'x-api-key': key },
    })
    const body = await state()
    expect(body.onAir.name).toBe('Desk Tester')
    expect(body.onAir.userId).not.toBeNull()
  })
})

describe('what is on which stage', () => {
  it('reads the running order the phones are syncing through the box', async () => {
    const body = await state()
    expect(body.runningOrder.known).toBe(true)
    const main = body.runningOrder.stages.find((s) => s.stage === 'Main Stage')
    expect(main?.onNow?.name).toBe('The Fixture')
  })

  it('counts down the stage that has not started yet', async () => {
    const second = (await state()).runningOrder.stages.find((s) => s.stage === 'Second Stage')
    expect(second?.onNow).toBeNull()
    expect(second?.next?.startsIn).toBe(30)
    expect(second?.next?.starts).toBe('in 30 min')
  })

  it('answers about one stage when a button only cares about one', async () => {
    // Case-insensitively: whoever typed the stage into the button is not the
    // person who typed it into the running order.
    const body = await state('?stage=main%20STAGE')
    expect(body.runningOrder.stages).toHaveLength(1)
    expect(body.runningOrder.stages[0]?.stage).toBe('Main Stage')
  })

  it('has nothing to say about a stage nobody has heard of', async () => {
    expect((await state('?stage=Nowhere')).runningOrder.stages).toEqual([])
  })
})

describe('posting a message from the desk', () => {
  const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/control/message', payload: body, headers })

  const bodies = (channelName: string): string[] => {
    const channel = store.getChannelByName(channelName)!
    return store.listBefore(channel.id, channel.lastSeq + 1, 50).map((m) => m.body)
  }

  it('turns away a request with no key', async () => {
    expect((await post({ channel: 'general', body: 'hello' })).statusCode).toBe(401)
  })

  it('puts the message in the channel', async () => {
    const res = await post({ channel: 'general', body: 'Changeover started' }, { 'x-api-key': key })
    expect(res.statusCode).toBe(200)
    expect(bodies('general')).toContain('Changeover started')
  })

  it('posts as the box rather than as a person', async () => {
    // A desk key that could write under a crew member's name is a desk key
    // that can put an instruction in somebody's mouth on a comms channel.
    await post({ channel: 'general', body: 'Doors in five' }, { 'x-api-key': key })
    const channel = store.getChannelByName('general')!
    const message = store
      .listBefore(channel.id, channel.lastSeq + 1, 50)
      .find((m) => m.body === 'Doors in five')
    expect(message?.kind).toBe('system')
    expect(message?.authorId).toBeNull()
  })

  it('takes the channel with a hash on it, which is how it is written down', async () => {
    const res = await post({ channel: '#general', body: 'Ten minute call' }, { 'x-api-key': key })
    expect(res.statusCode).toBe(200)
  })

  it('says so when the channel does not exist', async () => {
    // Rather than 200 and a message nobody will ever read, which is how a
    // renamed channel turns into a button that silently stopped working.
    const res = await post({ channel: 'stage-left', body: 'hello' }, { 'x-api-key': key })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: expect.stringContaining('stage-left') })
  })

  it('refuses to write into a DM', async () => {
    const [a, b] = [
      store.createUser('Ana Silva', 'x', 'member'),
      store.createUser('Bo Nkemelu', 'x', 'member'),
    ]
    const dm = store.getOrCreateDm(a.id, b.id)
    const res = await post({ channel: dm.id, body: 'hello' }, { 'x-api-key': key })
    expect(res.statusCode).toBe(404)
  })

  it('refuses an empty message', async () => {
    expect((await post({ channel: 'general', body: '   ' }, { 'x-api-key': key })).statusCode).toBe(
      400
    )
  })
})

describe('a box nobody has the app open on', () => {
  it('says it does not know the running order, rather than that there is none', async () => {
    // The relay holds documents for connected clients and nothing else. "I am
    // not holding a copy" and "the running order is empty" are different
    // answers, and a desk showing a blank stage all night because the last
    // phone went home would be the wrong one.
    phone.disconnect()
    await waitFor(() => app.docs.peek(TIMETABLE_ROOM) === null)
    const body = await state()
    expect(body.runningOrder.known).toBe(false)
    expect(body.runningOrder.stages).toEqual([])
  })
})
