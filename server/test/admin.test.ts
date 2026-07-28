import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { buildApp, type App } from '../src/app.ts'
import { AdminTokens, hashPin, newAdminPassword, verifyPin } from '../src/auth.ts'

/**
 * Admin used to be a property of a person: the first crew member to join got
 * it, for good. That rule cost a real box its admin panel — the admin deleted
 * their own account and there was no way back in short of editing SQLite.
 *
 * It is now a password, and the two things this suite exists to defend are
 * the two that failure mode taught us:
 *
 *   - a box always has a way in, even one that has never been configured;
 *   - and nothing behind the panel opens without the password, including the
 *     moderation powers that used to ride on the admin role.
 */

const EVENT_PIN = '9999'
let dir: string
let db: DatabaseSync
let store: Store
let app: App

const build = (adminPassword?: string): App =>
  buildApp({
    store,
    eventPin: EVENT_PIN,
    ...(adminPassword ? { adminPassword } : {}),
    filesDir: dir,
    dataDir: dir,
    logger: false,
  })

beforeEach(() => {
  dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-admin-'))
  db = openDb(':memory:')
  store = new Store(db)
  store.createChannel('general', 'public', 'Everyone')
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

const join = async (name: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, eventPin: EVENT_PIN, personalPin: '1234' },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { token: string }).token
}

const unlock = (token: string, password: string) =>
  app.inject({
    method: 'POST',
    url: '/api/admin/unlock',
    headers: { authorization: `Bearer ${token}` },
    payload: { password },
  })

const settings = (token: string, adminToken?: string) =>
  app.inject({
    method: 'GET',
    url: '/api/admin/settings',
    headers: {
      authorization: `Bearer ${token}`,
      ...(adminToken ? { 'x-admin-token': adminToken } : {}),
    },
  })

describe('the box always has a way in', () => {
  it('mints a password on first start and stores only its hash', () => {
    app = build()
    const hash = store.getSetting('adminPasswordHash')
    expect(hash).toBeTruthy()
    // The plaintext must not be recoverable from the database — that file is
    // what backup.sh copies to a USB stick taped to the server.
    expect(hash).not.toMatch(/-/)
    expect(hash!.split(':')).toHaveLength(2)
  })

  it('keeps the same password across restarts', async () => {
    app = build()
    const first = store.getSetting('adminPasswordHash')
    await app.close()
    // Same store, new process: a box that re-minted its password on every
    // restart would print a new one to a console nobody is watching.
    app = build()
    expect(store.getSetting('adminPasswordHash')).toBe(first)
  })

  it('lets ADMIN_PASSWORD override a stored one, which is the way back in', async () => {
    app = build()
    await app.close()
    // The stored password is lost — nobody wrote it down. Setting the env var
    // and restarting has to work, or the box is bricked for its owner.
    app = build('rescue-password')
    const token = await join('Alex')
    expect((await unlock(token, 'rescue-password')).statusCode).toBe(200)
  })

  it('generates passwords that are unguessable and typable', () => {
    const passwords = Array.from({ length: 200 }, () => newAdminPassword())
    expect(new Set(passwords).size).toBe(200)
    for (const password of passwords) {
      // 'o' is in the alphabet on purpose — there is no '0' for it to be
      // confused with. 'i' and 'l' are out, because they are confusable with
      // each other in most terminal fonts, and this gets read off a screen in
      // the dark and typed into a phone.
      expect(password).toMatch(/^[a-hjkmn-z2-9]{4}-[a-hjkmn-z2-9]{4}-[a-hjkmn-z2-9]{4}$/)
      expect(password).not.toMatch(/[il]/)
    }
  })
})

describe('unlocking', () => {
  it('trades the right password for a token, and refuses the wrong one', async () => {
    app = build('correct-horse')
    const token = await join('Alex')

    const bad = await unlock(token, 'wrong')
    expect(bad.statusCode).toBe(401)
    expect((bad.json() as { error: string }).error).toMatch(/admin password/i)

    const good = await unlock(token, 'correct-horse')
    expect(good.statusCode).toBe(200)
    expect((good.json() as { adminToken: string }).adminToken).toBeTruthy()
  })

  it('will not unlock for someone who is not signed in', async () => {
    // Matters once a tunnel puts the join page on the internet: an anonymous
    // client should not even be able to guess at this route.
    app = build('correct-horse')
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/unlock',
      payload: { password: 'correct-horse' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects the event PIN, which is the first thing anyone will try', async () => {
    app = build('correct-horse')
    const token = await join('Alex')
    expect((await unlock(token, EVENT_PIN)).statusCode).toBe(401)
  })

  it('rate-limits guessing', async () => {
    app = build('correct-horse')
    const token = await join('Alex')
    for (let i = 0; i < 10; i++) expect((await unlock(token, `guess-${i}`)).statusCode).toBe(401)
    const blocked = await unlock(token, 'guess-11')
    expect(blocked.statusCode).toBe(429)
    // Even the correct password waits out the cooldown — otherwise the limit
    // is only a speed bump for whoever guesses right on attempt eleven.
    expect((await unlock(token, 'correct-horse')).statusCode).toBe(429)
  })
})

describe('what the unlock actually gates', () => {
  it('refuses the panel to a signed-in member with no unlock', async () => {
    app = build('correct-horse')
    const token = await join('Alex')
    const res = await settings(token)
    // 403 not 401: their session is fine, the panel is locked. The client
    // tells these apart — one re-prompts, the other signs them out.
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: string }).error).toMatch(/locked/)
  })

  it('opens it with one', async () => {
    app = build('correct-horse')
    const token = await join('Alex')
    const { adminToken } = (await unlock(token, 'correct-horse')).json() as { adminToken: string }
    const res = await settings(token, adminToken)
    expect(res.statusCode).toBe(200)
    expect((res.json() as { serverInfo: { eventPin: string } }).serverInfo.eventPin).toBe(EVENT_PIN)
  })

  it('refuses a made-up token', async () => {
    app = build('correct-horse')
    const token = await join('Alex')
    expect((await settings(token, 'not-a-real-token')).statusCode).toBe(403)
  })

  it('never sends the admin password back, only whether it can be changed', async () => {
    app = build('correct-horse')
    const token = await join('Alex')
    const { adminToken } = (await unlock(token, 'correct-horse')).json() as { adminToken: string }
    const body = (await settings(token, adminToken)).json() as Record<string, unknown>
    expect(JSON.stringify(body)).not.toContain('correct-horse')
    expect((body.serverInfo as { adminPasswordFromEnv: boolean }).adminPasswordFromEnv).toBe(true)
  })
})

describe('changing the password', () => {
  /**
   * Seed a known stored password, so the box behaves exactly as it does after
   * an admin has set one — no env override, and therefore changeable.
   */
  const buildWithStored = (password: string): App => {
    store.setSetting('adminPasswordHash', hashPin(password))
    return build()
  }

  const change = (token: string, adminToken: string, adminPassword: string) =>
    app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${token}`, 'x-admin-token': adminToken },
      payload: { adminPassword },
    })

  it('takes effect: the new password works and the old one stops', async () => {
    app = buildWithStored('starting-password')
    const token = await join('Alex')
    const adminToken = ((await unlock(token, 'starting-password')).json() as { adminToken: string })
      .adminToken

    expect((await change(token, adminToken, 'a-better-password')).statusCode).toBe(200)
    expect(verifyPin('a-better-password', store.getSetting('adminPasswordHash')!)).toBe(true)
    expect(verifyPin('starting-password', store.getSetting('adminPasswordHash')!)).toBe(false)
  })

  it('locks every other device, and keeps the one that made the change', async () => {
    app = buildWithStored('starting-password')
    const token = await join('Alex')
    const mine = ((await unlock(token, 'starting-password')).json() as { adminToken: string })
      .adminToken
    const theirs = ((await unlock(token, 'starting-password')).json() as { adminToken: string })
      .adminToken
    expect((await settings(token, theirs)).statusCode).toBe(200)

    const res = await change(token, mine, 'a-better-password')
    expect(res.statusCode).toBe(200)

    // The other device is out. Changing a password you think is compromised
    // has to actually end the access it granted.
    expect((await settings(token, theirs)).statusCode).toBe(403)
    // So is the token that made the change — but a replacement comes back
    // with it, so the admin isn't thrown out by their own edit.
    expect((await settings(token, mine)).statusCode).toBe(403)
    const { adminToken: replacement } = res.json() as { adminToken: string }
    expect(replacement).toBeTruthy()
    expect((await settings(token, replacement)).statusCode).toBe(200)
  })

  it('refuses a password too short to be worth having', async () => {
    app = buildWithStored('starting-password')
    const token = await join('Alex')
    const adminToken = ((await unlock(token, 'starting-password')).json() as { adminToken: string })
      .adminToken
    expect((await change(token, adminToken, 'short')).statusCode).toBe(400)
    expect(verifyPin('starting-password', store.getSetting('adminPasswordHash')!)).toBe(true)
  })

  it('refuses when ADMIN_PASSWORD owns it, rather than pretending to save', async () => {
    // Silently accepting would be worse than refusing: the panel would report
    // success and the old password would keep working.
    app = build('from-the-env')
    const token = await join('Alex')
    const { adminToken } = (await unlock(token, 'from-the-env')).json() as { adminToken: string }
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${token}`, 'x-admin-token': adminToken },
      payload: { adminPassword: 'something-else' },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toMatch(/ADMIN_PASSWORD/)
    expect((await unlock(token, 'from-the-env')).statusCode).toBe(200)
  })
})

describe('unlock tokens', () => {
  it('expire', () => {
    const tokens = new AdminTokens(-1) // already elapsed
    expect(tokens.valid(tokens.issue())).toBe(false)
  })

  it('are independent of each other', () => {
    const tokens = new AdminTokens(60_000)
    const a = tokens.issue()
    const b = tokens.issue()
    tokens.revoke(a)
    expect(tokens.valid(a)).toBe(false)
    expect(tokens.valid(b)).toBe(true)
  })

  it('all die together when the password changes', () => {
    const tokens = new AdminTokens(60_000)
    const a = tokens.issue()
    const b = tokens.issue()
    tokens.revokeAll()
    expect(tokens.valid(a)).toBe(false)
    expect(tokens.valid(b)).toBe(false)
  })

  it('treats a missing token as no token', () => {
    const tokens = new AdminTokens(60_000)
    expect(tokens.valid(undefined)).toBe(false)
    expect(tokens.valid('')).toBe(false)
  })
})
