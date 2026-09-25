import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashToken, openDb, runMigrations } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { buildApp, type App } from '../src/app.ts'

/**
 * A sign-in renewed (`POST /api/session/renew`): what the apps ask for each
 * sign-in they moved out of the web view's storage, which backups and
 * phone-to-phone transfers carry, so that a copy on another phone signs
 * nothing in there (web/src/lib/sessions.ts). The new one stands in for the
 * old until it is first used (migration v13); sync.test.ts has the hello.
 */

let app: App
let db: DatabaseSync
let store: Store

afterEach(async () => {
  vi.useRealTimers()
  await app.close()
})

function newApp(sessionTtlMs?: number): App {
  db = openDb(':memory:')
  store = new Store(db)
  app = buildApp({
    store,
    eventPin: '4242',
    logger: false,
    ...(sessionTtlMs ? { sessionTtlMs } : {}),
  })
  return app
}

const join = async (name = 'Sam') =>
  (
    await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name, eventPin: '4242', personalPin: '1234' },
    })
  ).json() as { token: string; user: { id: string } }

const me = (token: string) =>
  app.inject({ url: '/api/me', headers: { authorization: `Bearer ${token}` } })

const renew = (token?: string) =>
  app.inject({
    method: 'POST',
    url: '/api/session/renew',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  })

const renewed = async (token: string) => {
  const res = await renew(token)
  expect(res.statusCode).toBe(200)
  return (res.json() as { token: string }).token
}

describe('renewing a sign-in', () => {
  it('gives a new token for the same person, and the old one stops once it is used', async () => {
    newApp()
    const { token, user } = await join()
    const next = await renewed(token)
    expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(next).not.toBe(token)
    expect((await me(next)).json()).toMatchObject({ user: { id: user.id, name: 'Sam' } })
    expect((await me(token)).statusCode).toBe(401)
    expect((await me(next)).statusCode).toBe(200)
  })

  it('is a sign-in like any other once used, with nothing more to write for it', async () => {
    newApp()
    const { token } = await join()
    const next = await renewed(token)
    const standsIn = () =>
      db.prepare('SELECT renews FROM sessions WHERE token_sha = ?').get(hashToken(next))
    expect(standsIn()).toEqual({ renews: hashToken(token) })
    await me(next)
    expect(standsIn()).toEqual({ renews: null })
  })

  it('leaves the old one working until then, for a phone that never heard the answer', async () => {
    newApp()
    const { token } = await join()
    const lost = await renewed(token)
    expect((await me(token)).statusCode).toBe(200)
    // It asks again at its next start, and that answer is the one it uses.
    const next = await renewed(token)
    expect((await me(next)).statusCode).toBe(200)
    expect((await me(token)).statusCode).toBe(401)
    expect((await me(lost)).statusCode).toBe(401)
  })

  it('keeps one stand-in at a time, however often a phone asks', async () => {
    newApp()
    const { token, user } = await join()
    for (let i = 0; i < 5; i++) await renewed(token)
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id)).toEqual(
      {
        n: 2,
      }
    )
  })

  it('is one phone’s: a copy that asks after the new one is used gets nothing', async () => {
    newApp()
    const { token } = await join()
    const first = await renewed(token)
    expect((await me(first)).statusCode).toBe(200)
    const copy = await renew(token)
    expect(copy.statusCode).toBe(401)
    expect(copy.json()).not.toHaveProperty('token')
    expect((await me(first)).statusCode).toBe(200)
  })

  it('is one phone’s when both ask before either uses it: the later ask’s', async () => {
    newApp()
    const { token } = await join()
    const first = await renewed(token)
    const second = await renewed(token)
    expect((await me(first)).statusCode).toBe(401)
    expect((await me(second)).statusCode).toBe(200)
    expect((await me(token)).statusCode).toBe(401)
    expect((await me(first)).statusCode).toBe(401)
  })

  it('renews a stand-in that was never used, and settles it first', async () => {
    // An app stopped between keeping the new token and forgetting that the
    // sign-in needed renewing: its next start asks with the new one.
    newApp()
    const { token } = await join()
    const kept = await renewed(token)
    const next = await renewed(kept)
    expect((await me(token)).statusCode).toBe(401)
    expect((await me(next)).statusCode).toBe(200)
    expect((await me(kept)).statusCode).toBe(401)
  })

  it('leaves every other sign-in as it was, the same person’s other phone’s included', async () => {
    newApp()
    const sam = await join('Sam')
    const alex = await join('Alex')
    const samsTablet = await join('Sam')
    const next = await renewed(sam.token)
    expect((await me(next)).statusCode).toBe(200)
    expect((await me(alex.token)).statusCode).toBe(200)
    expect((await me(samsTablet.token)).statusCode).toBe(200)
  })

  it('refuses without a sign-in, or with one that isn’t one', async () => {
    newApp()
    expect((await renew()).statusCode).toBe(401)
    expect((await renew('not-a-sign-in')).statusCode).toBe(401)
    expect(store.renewSession('not-a-sign-in', 'n'.repeat(43))).toBe(false)
    expect(store.getSessionUser('n'.repeat(43))).toBeUndefined()
  })

  it('doesn’t bring back a sign-in that has run out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    newApp(60_000)
    const { token } = await join()
    vi.setSystemTime(Date.now() + 120_000)
    expect((await renew(token)).statusCode).toBe(401)
    expect((await me(token)).statusCode).toBe(401)
  })

  it('goes with the account, stand-in and all', async () => {
    newApp()
    const { token, user } = await join()
    const next = await renewed(token)
    store.deleteUser(user.id)
    expect((await me(token)).statusCode).toBe(401)
    expect((await me(next)).statusCode).toBe(401)
  })

  it('still signs the new one in when the box can’t write down that it was used', async () => {
    // A full disk: the old one lives on until a use that can.
    newApp()
    const { token } = await join()
    const next = await renewed(token)
    const prepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      if (/^\s*(DELETE|UPDATE)/i.test(sql)) throw new Error('SQLITE_FULL: database or disk is full')
      return prepare(sql)
    }
    try {
      expect((await me(next)).statusCode).toBe(200)
      expect((await me(token)).statusCode).toBe(200)
    } finally {
      db.prepare = prepare
    }
    expect((await me(next)).statusCode).toBe(200)
    expect((await me(token)).statusCode).toBe(401)
  })
})

describe('a box from before sign-ins were renewed', () => {
  it('keeps its sign-ins through the update, and renews them', async () => {
    newApp()
    const { token } = await join()
    db.exec('ALTER TABLE sessions DROP COLUMN renews; PRAGMA user_version = 12;')
    runMigrations(db)
    expect((await me(token)).statusCode).toBe(200)
    const next = await renewed(token)
    expect((await me(next)).statusCode).toBe(200)
    expect((await me(token)).statusCode).toBe(401)
  })

  it('starts on a database walked up again that has the column already', () => {
    // As one rebuilt by hand from a `.dump` can be: a migration that throws
    // stops the box from starting.
    newApp()
    db.exec('PRAGMA user_version = 12')
    expect(() => runMigrations(db)).not.toThrow()
  })
})
