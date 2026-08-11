import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type App } from '../src/app.ts'
import { hashPin } from '../src/auth.ts'
import { controlKey } from '../src/control.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'

/**
 * The tally, over the wire it will actually be driven on.
 *
 * The unit tests cover the state machine; what is worth an integration test
 * is the boundary — that a vision desk without the key gets nothing, that a
 * desk with it can name a crew member the way a human would (by name, not by
 * a database id nobody has), and that the box says so plainly when the name
 * is wrong rather than lighting nobody up and returning success.
 */

const EVENT_PIN = '9999'
let dir: string
let db: DatabaseSync
let store: Store
let app: App
let key: string

beforeEach(() => {
  dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-tally-'))
  db = openDb(pathJoin(dir, 'test.db'))
  store = new Store(db)
  store.createUser('Dev Okafor', hashPin('1234'), 'member')
  app = buildApp({ store, eventPin: EVENT_PIN, filesDir: dir, dataDir: dir, logger: false })
  key = controlKey(store, {})
})

afterEach(async () => {
  await app.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/control/tally', payload: body, headers })

describe('who may raise a tally', () => {
  it('turns away a request with no key at all', async () => {
    expect((await post({ user: 'Dev Okafor' })).statusCode).toBe(401)
  })

  it('turns away a wrong key', async () => {
    const res = await post({ user: 'Dev Okafor' }, { 'x-api-key': 'not-the-key' })
    expect(res.statusCode).toBe(401)
  })

  it('lets the box’s own key through', async () => {
    const res = await post({ user: 'Dev Okafor' }, { 'x-api-key': key })
    expect(res.statusCode).toBe(200)
  })

  it('accepts the key as a bearer token, which is what most desks send', async () => {
    const res = await post({ user: 'Dev Okafor' }, { authorization: `Bearer ${key}` })
    expect(res.statusCode).toBe(200)
  })
})

describe('naming the person on camera', () => {
  it('takes a name, because that is what whoever built the button knows', async () => {
    const res = await post({ user: 'Dev Okafor' }, { 'x-api-key': key })
    const body = res.json() as { userId: string }
    expect(body.userId).toBe(store.listUsers()[0]!.id)
  })

  it('is not fussy about case', async () => {
    const res = await post({ user: 'dev okafor' }, { 'x-api-key': key })
    expect((res.json() as { userId: string | null }).userId).not.toBeNull()
  })

  it('takes an id too, for a desk that stored one', async () => {
    const id = store.listUsers()[0]!.id
    const res = await post({ user: id }, { 'x-api-key': key })
    expect((res.json() as { userId: string }).userId).toBe(id)
  })

  it('says so when the name matches nobody', async () => {
    // Rather than returning success having lit nobody up, which is how a
    // renamed crew member turns into a tally that silently stopped working.
    const res = await post({ user: 'Nobody At All' }, { 'x-api-key': key })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: expect.stringContaining('Nobody At All') })
  })

  it('clears on an explicit null', async () => {
    await post({ user: 'Dev Okafor' }, { 'x-api-key': key })
    const res = await post({ user: null }, { 'x-api-key': key })
    expect((res.json() as { userId: string | null }).userId).toBeNull()
  })

  it('refuses an empty body rather than treating it as "off air"', async () => {
    // A missing field arriving by accident must not take a live camera's
    // tally down. Saying "nobody is on air" has to be deliberate.
    expect((await post({}, { 'x-api-key': key })).statusCode).toBe(400)
  })
})

describe('a desk that polls, and a stranger that guesses', () => {
  it('never throttles a desk holding the right key', async () => {
    // A Stream Deck asks what is on air a second at a time all night, which
    // is the whole point of this surface. Counting those against a limiter
    // meant for guessers would turn a busy show into a dead button.
    const codes = new Set<number>()
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/control/tally',
        headers: { 'x-api-key': key },
      })
      codes.add(res.statusCode)
    }
    expect([...codes]).toEqual([200])
  })

  it('says "too many" rather than "wrong key" once a guesser is throttled', async () => {
    // A 401 here would send whoever built the button off to check a key that
    // was right all along.
    let last = 0
    for (let i = 0; i < 130; i++) {
      last = (await post({ user: 'Dev Okafor' }, { 'x-api-key': `guess-${i}` })).statusCode
    }
    expect(last).toBe(429)
  })
})

describe('a desk that reconnected', () => {
  it('can read back what is on air', async () => {
    await post({ user: 'Dev Okafor' }, { 'x-api-key': key })
    const res = await app.inject({
      method: 'GET',
      url: '/api/control/tally',
      headers: { 'x-api-key': key },
    })
    expect((res.json() as { userId: string | null }).userId).not.toBeNull()
  })

  it('cannot read it without the key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/control/tally' })
    expect(res.statusCode).toBe(401)
  })
})
