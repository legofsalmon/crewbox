import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { newId, type Incident, type ServerMessage } from '@crewbox/shared'
import { attachWs, buildApp, type App } from '../src/app.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'

/**
 * The show log.
 *
 * Two properties carry this feature, and both are tested here rather than
 * assumed: an entry that was filed is never lost (retries dedupe, and nothing
 * updates or deletes a row), and an entry says when the thing *happened*
 * rather than when somebody found a hand free to type it.
 */

const EVENT_PIN = '9999'
let dir: string
let db: DatabaseSync
let store: Store
let app: App
let wsUrl: string
const sockets: WebSocket[] = []

beforeEach(() => {
  dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-incidents-'))
  db = openDb(pathJoin(dir, 'test.db'))
  store = new Store(db)
  store.createChannel('general', 'public', '')
})

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close()
  if (app) await app.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const entry = (over: Partial<Parameters<Store['appendIncident']>[0]> = {}) =>
  store.appendIncident({
    authorId: null,
    authorName: 'Maya Quinn',
    kind: 'note',
    severity: 'note',
    body: 'Barrier moved back a metre at stage left',
    at: Date.UTC(2026, 7, 11, 20, 30),
    ...over,
  })

describe('filing an entry', () => {
  it('numbers entries across the whole box, not per channel', () => {
    // One show, one log. An entry filed by lighting belongs to the same night
    // as one filed by stage management, and the sequence says so.
    expect(entry().incident.seq).toBe(1)
    expect(entry().incident.seq).toBe(2)
    expect(store.latestIncidentSeq()).toBe(2)
  })

  it('keeps when it happened apart from when it was written down', () => {
    // Ten minutes ago: the gap between the thing happening and somebody
    // getting a hand free is the whole reason there are two timestamps.
    const happened = Date.now() - 10 * 60_000
    const { incident } = entry({ at: happened })
    expect(incident.at).toBe(happened)
    expect(incident.loggedAt).toBeGreaterThan(happened)
  })

  it('files a retry once, not twice', () => {
    // The failure this guards is specific and bad: a phone logs a show stop,
    // loses Wi-Fi before the acknowledgement, and retries. Two show stops in
    // the record is a worse answer than none.
    const clientMsgId = newId()
    const first = entry({ clientMsgId })
    const second = entry({ clientMsgId })
    expect(second.deduped).toBe(true)
    expect(second.incident.id).toBe(first.incident.id)
    expect(store.latestIncidentSeq()).toBe(1)
  })

  it('carries what was on stage at the time, by name as well as by id', () => {
    // The one place this codebase stores a copy rather than a reference: the
    // record has to keep saying "during Night Bus" after somebody corrects
    // the running order, or deletes the act entirely.
    const { incident } = entry({ stage: 'Main Stage', actId: 'act-7', actName: 'Night Bus' })
    expect(incident).toMatchObject({ stage: 'Main Stage', actId: 'act-7', actName: 'Night Bus' })
  })
})

describe('correcting the record', () => {
  it('writes the correction underneath rather than over', () => {
    const original = entry({ body: 'Show stopped 21:04' }).incident
    const correction = entry({ body: 'Correction: 21:14, not 21:04', amends: original.id }).incident

    const log = store.listIncidentsBefore(store.latestIncidentSeq() + 1, 50)
    expect(log).toHaveLength(2)
    expect(correction.amends).toBe(original.id)
    // The original is still there, word for word.
    expect(log.find((i) => i.id === original.id)?.body).toBe('Show stopped 21:04')
  })
})

describe('reading the log back', () => {
  it('comes back newest first, a page at a time', () => {
    for (let i = 0; i < 5; i++) entry({ body: `entry ${i}` })
    const page = store.listIncidentsBefore(store.latestIncidentSeq() + 1, 2)
    expect(page.map((i) => i.body)).toEqual(['entry 4', 'entry 3'])
    expect(store.listIncidentsBefore(page[1]!.seq, 2).map((i) => i.body)).toEqual([
      'entry 2',
      'entry 1',
    ])
  })

  it('orders by the sequence, not by the time claimed', () => {
    // An entry back-dated by ten minutes must not jump above one somebody
    // has already read. Display can sort by `at`; the record cannot.
    const first = entry({ at: Date.UTC(2026, 7, 11, 21, 0) }).incident
    const backdated = entry({ at: Date.UTC(2026, 7, 11, 20, 0) }).incident
    expect(store.listIncidentsBefore(99, 10).map((i) => i.id)).toEqual([backdated.id, first.id])
  })

  it('gives a window oldest-first, for the report', () => {
    entry({ at: Date.UTC(2026, 7, 11, 19, 0), body: 'doors' })
    entry({ at: Date.UTC(2026, 7, 11, 23, 0), body: 'curfew' })
    entry({ at: Date.UTC(2026, 7, 12, 9, 0), body: 'next morning' })
    const night = store.listIncidentsBetween(
      Date.UTC(2026, 7, 11, 12, 0),
      Date.UTC(2026, 7, 12, 6, 0)
    )
    expect(night.map((i) => i.body)).toEqual(['doors', 'curfew'])
  })
})

describe('when somebody deletes their account', () => {
  it('keeps the entry and lets go of the person', () => {
    // The two halves of the promise: what happened at 21:04 is the event's
    // record, and who typed it is theirs.
    const user = store.createUser('Maya Quinn', 'hash', 'member')
    entry({ authorId: user.id, authorName: user.name, body: 'Show stopped' })
    store.deleteUser(user.id)

    const [logged] = store.listIncidentsBefore(99, 10)
    expect(logged?.body).toBe('Show stopped')
    expect(logged?.authorId).toBeNull()
    expect(logged?.authorName).toBe('')
  })
})

// -- over the wire ----------------------------------------------------------

const startApp = async (modules = ['chat', 'incident']) => {
  app = buildApp({ store, eventPin: EVENT_PIN, dataDir: dir, modules, logger: false })
  await app.listen({ port: 0, host: '127.0.0.1' })
  attachWs(app)
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  wsUrl = `ws://127.0.0.1:${port}/ws`
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name: 'Maya Quinn', eventPin: EVENT_PIN, personalPin: '1234' },
  })
  return (res.json() as { token: string }).token
}

class Client {
  ws: WebSocket
  received: ServerMessage[] = []

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.on('message', (data) => this.received.push(JSON.parse(String(data)) as ServerMessage))
    sockets.push(this.ws)
  }

  async open(token: string): Promise<void> {
    // The readyState guard matters: a socket constructed before an earlier
    // await can already be open by the time this runs, and `once('open')`
    // would then wait for an event that has been and gone.
    if (this.ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        this.ws.once('open', () => resolve())
        this.ws.once('error', reject)
      })
    }
    this.ws.send(JSON.stringify({ type: 'hello', token, cursors: {} }))
    await this.wait((m) => m.type === 'welcome')
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg))
  }

  async wait<T extends ServerMessage>(
    predicate: (m: ServerMessage) => boolean,
    timeoutMs = 3000
  ): Promise<T> {
    const start = Date.now()
    for (;;) {
      const found = this.received.find(predicate)
      if (found) return found as T
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for a message')
      await new Promise((r) => setTimeout(r, 15))
    }
  }
}

describe('filing over the socket', () => {
  it('reaches every crew member on the box, not just a channel', async () => {
    const token = await startApp()
    const author = new Client(wsUrl)
    const other = new Client(wsUrl)
    await author.open(token)
    await other.open(token)

    author.send({
      type: 'logIncident',
      clientMsgId: newId(),
      kind: 'show-stop',
      severity: 'serious',
      body: 'Show stopped — wind reading over limit',
      at: Date.now(),
      stage: 'Main Stage',
    })

    const seen = await other.wait<Extract<ServerMessage, { type: 'incident' }>>(
      (m) => m.type === 'incident'
    )
    expect(seen.incident.body).toContain('wind reading')
    expect(seen.incident.authorName).toBe('Maya Quinn')
  })

  it('refuses a time a day out, and says why', async () => {
    // A phone that never reached NTP on an offline site. Filing its entry in
    // 1970 would put it somewhere nobody ever looks again.
    const token = await startApp()
    const client = new Client(wsUrl)
    await client.open(token)

    client.send({
      type: 'logIncident',
      clientMsgId: newId(),
      body: 'Filed by a phone with a wrong clock',
      at: 1_000_000,
    })

    const rejected = await client.wait<Extract<ServerMessage, { type: 'rejected' }>>(
      (m) => m.type === 'rejected'
    )
    expect(rejected.reason).toContain("box's clock")
    expect(store.latestIncidentSeq()).toBe(0)
  })
})

describe('reading the scrollback', () => {
  it('needs a session', async () => {
    await startApp()
    expect((await app.inject({ method: 'GET', url: '/api/incidents' })).statusCode).toBe(401)
  })

  it('is not there at all when the box has the module off', async () => {
    const token = await startApp(['chat'])
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('hands back the log for any crew member', async () => {
    const token = await startApp()
    entry({ body: 'Barrier moved' })
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { incidents: Incident[] }).incidents[0]?.body).toBe('Barrier moved')
  })
})
