import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMentioned, messageAlertKind, type Department, type User } from '@crewbox/shared'
import { openDb, runMigrations } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { buildApp, type App } from '../src/app.ts'
import { AdminTokens, hashPin } from '../src/auth.ts'

/**
 * Admins as people, and departments.
 *
 * An admin is somebody another admin chose, and opens the panel with their
 * own PIN. The box's password and its admin link stay a way in for anybody,
 * so the things worth defending here are that the role means exactly that
 * (nobody is an admin by being early, a PIN unlock is that person's alone
 * and ends when they stop being one) and that a department reaches its
 * people by `@` without deciding what anybody can see.
 */

const EVENT_PIN = '9999'
const PASSWORD = 'correct-horse'
let dir: string
let db: DatabaseSync
let store: Store
let app: App

beforeEach(() => {
  dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-people-'))
  db = openDb(':memory:')
  store = new Store(db)
  store.createChannel('general', 'public', 'Everyone')
  app = buildApp({
    store,
    eventPin: EVENT_PIN,
    adminPassword: PASSWORD,
    filesDir: dir,
    dataDir: dir,
    logger: false,
  })
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

const join = async (name: string, personalPin = '1234'): Promise<{ token: string; user: User }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, eventPin: EVENT_PIN, personalPin },
  })
  expect(res.statusCode).toBe(200)
  return res.json() as { token: string; user: User }
}

const unlock = async (token: string, secret: { password: string } | { pin: string }) =>
  app.inject({
    method: 'POST',
    url: '/api/admin/unlock',
    headers: { authorization: `Bearer ${token}` },
    payload: secret,
  })

const adminToken = async (token: string, secret: { password: string } | { pin: string }) => {
  const res = await unlock(token, secret)
  expect(res.statusCode).toBe(200)
  return (res.json() as { adminToken: string }).adminToken
}

const as = (token: string, admin?: string) => ({
  authorization: `Bearer ${token}`,
  ...(admin ? { 'x-admin-token': admin } : {}),
})

const patchUser = (token: string, admin: string, id: string, payload: object) =>
  app.inject({ method: 'PATCH', url: `/api/admin/users/${id}`, headers: as(token, admin), payload })

const settings = (token: string, admin: string) =>
  app.inject({ method: 'GET', url: '/api/admin/settings', headers: as(token, admin) })

describe('upgrading a box', () => {
  it('adds departments and makes nobody an admin for having joined first', () => {
    // A box from before admin became a password still has the first joiner's
    // row marked 'admin'. Read now, that would hand them the panel.
    const old = openDb(':memory:')
    old.exec('ALTER TABLE users DROP COLUMN department_id')
    old.exec('DROP TABLE departments')
    old.exec('PRAGMA user_version = 15')
    old
      .prepare(
        "INSERT INTO users (id, name, role, pin_hash, created_at) VALUES (?, ?, 'admin', ?, ?)"
      )
      .run('u1', 'Early', hashPin('1234'), 1)

    runMigrations(old)

    const upgraded = new Store(old)
    const early = upgraded.getUserById('u1')!
    expect(early.role).toBe('member')
    expect(early.departmentId).toBeUndefined()
    expect(upgraded.listDepartments()).toEqual([])
    // The person and their PIN are untouched.
    expect(upgraded.getUserPinHash('u1')).toBeTruthy()
  })
})

describe('admins as people', () => {
  it('lets an unlocked admin make somebody an admin, who then opens it with their own PIN', async () => {
    const alex = await join('Alex')
    const sam = await join('Sam', '5678')
    const panel = await adminToken(alex.token, { password: PASSWORD })

    const made = await patchUser(alex.token, panel, sam.user.id, { role: 'admin' })
    expect(made.statusCode).toBe(200)
    expect((made.json() as { user: User }).user.role).toBe('admin')

    const own = await adminToken(sam.token, { pin: '5678' })
    expect((await settings(sam.token, own)).statusCode).toBe(200)
  })

  it('refuses the PIN route to somebody who is not an admin', async () => {
    const alex = await join('Alex')
    const res = await unlock(alex.token, { pin: '1234' })
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: string }).error).toMatch(/not an admin/i)
  })

  it('refuses a wrong PIN, and counts it against the same name as signing in does', async () => {
    const alex = await join('Alex')
    const panel = await adminToken(alex.token, { password: PASSWORD })
    await patchUser(alex.token, panel, alex.user.id, { role: 'admin' })

    expect((await unlock(alex.token, { pin: '0000' })).statusCode).toBe(401)
    for (let i = 1; i < 9; i++) {
      expect((await unlock(alex.token, { pin: `000${i}` })).statusCode).toBe(401)
    }
    // Nine wrong here and one wrong at sign-in make the ten the name is
    // allowed. One budget for one PIN: the right one is now held at both.
    const signIn = (personalPin: string) =>
      app.inject({
        method: 'POST',
        url: '/api/join',
        payload: { name: 'Alex', eventPin: EVENT_PIN, personalPin },
      })
    expect((await signIn('9999')).statusCode).toBe(401)
    const held = await signIn('1234')
    expect(held.statusCode).toBe(429)
  })

  it("keeps a PIN unlock in that person's hands", async () => {
    const alex = await join('Alex')
    const sam = await join('Sam', '5678')
    const panel = await adminToken(alex.token, { password: PASSWORD })
    await patchUser(alex.token, panel, sam.user.id, { role: 'admin' })
    const samsOwn = await adminToken(sam.token, { pin: '5678' })

    // Alex's session with Sam's unlock opens nothing.
    expect((await settings(alex.token, samsOwn)).statusCode).toBe(403)
  })

  it('ends their PIN unlock the moment they stop being an admin', async () => {
    const alex = await join('Alex')
    const sam = await join('Sam', '5678')
    const panel = await adminToken(alex.token, { password: PASSWORD })
    await patchUser(alex.token, panel, sam.user.id, { role: 'admin' })
    const samsOwn = await adminToken(sam.token, { pin: '5678' })

    await patchUser(alex.token, panel, sam.user.id, { role: 'member' })

    expect((await settings(sam.token, samsOwn)).statusCode).toBe(403)
    expect((await unlock(sam.token, { pin: '5678' })).statusCode).toBe(403)
    // The password is still a way in for them, as for anybody.
    expect((await unlock(sam.token, { password: PASSWORD })).statusCode).toBe(200)
  })

  it('needs an unlock to change anybody', async () => {
    const alex = await join('Alex')
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${alex.user.id}`,
      headers: as(alex.token),
      payload: { role: 'admin' },
    })
    expect(res.statusCode).toBe(403)
    expect(store.getUserById(alex.user.id)!.role).toBe('member')
  })

  it('still makes everyone who joins a member', async () => {
    const alex = await join('Alex')
    expect(alex.user.role).toBe('member')
  })
})

describe('departments', () => {
  const create = (token: string, admin: string, name: string) =>
    app.inject({
      method: 'POST',
      url: '/api/admin/departments',
      headers: as(token, admin),
      payload: { name },
    })

  it('are added, renamed and deleted by an admin, and refuse a name twice', async () => {
    const alex = await join('Alex')
    const panel = await adminToken(alex.token, { password: PASSWORD })

    const made = await create(alex.token, panel, 'Lighting')
    expect(made.statusCode).toBe(200)
    const lighting = (made.json() as { department: Department }).department

    expect((await create(alex.token, panel, 'lighting')).statusCode).toBe(409)

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/admin/departments/${lighting.id}`,
      headers: as(alex.token, panel),
      payload: { name: 'LX' },
    })
    expect((renamed.json() as { department: Department }).department.name).toBe('LX')

    await patchUser(alex.token, panel, alex.user.id, { departmentId: lighting.id })
    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/admin/departments/${lighting.id}`,
      headers: as(alex.token, panel),
    })
    expect(gone.statusCode).toBe(200)
    expect(store.listDepartments()).toEqual([])
    // The person stays, in no department.
    expect(store.getUserById(alex.user.id)!.departmentId).toBeUndefined()
  })

  it('refuse names that already mention everybody, or start another mention', async () => {
    const alex = await join('Alex')
    const panel = await adminToken(alex.token, { password: PASSWORD })
    for (const name of ['all', 'Everyone', 'channel', '@stage', 'foh#1', '   ']) {
      expect((await create(alex.token, panel, name)).statusCode).toBe(400)
    }
  })

  it('are each crew member’s own to pick, and refuse one that is gone', async () => {
    const alex = await join('Alex')
    const sam = await join('Sam')
    const panel = await adminToken(alex.token, { password: PASSWORD })
    const sound = ((await create(alex.token, panel, 'Sound')).json() as { department: Department })
      .department

    const picked = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: as(sam.token),
      payload: { departmentId: sound.id },
    })
    expect(picked.statusCode).toBe(200)
    expect(store.getUserById(sam.user.id)!.departmentId).toBe(sound.id)

    const none = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: as(sam.token),
      payload: { departmentId: null },
    })
    expect(none.statusCode).toBe(200)
    expect(store.getUserById(sam.user.id)!.departmentId).toBeUndefined()

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: as(sam.token),
      payload: { departmentId: 'nope' },
    })
    expect(missing.statusCode).toBe(404)
  })

  it('go in the export', async () => {
    const alex = await join('Alex')
    const panel = await adminToken(alex.token, { password: PASSWORD })
    await create(alex.token, panel, 'Stage')
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/export',
      headers: as(alex.token, panel),
    })
    expect((res.json() as { departments: Department[] }).departments.map((d) => d.name)).toEqual([
      'Stage',
    ])
  })
})

describe('@department', () => {
  const message = (body: string) => ({
    id: 'm',
    channelId: 'c',
    seq: 5,
    authorId: 'someone-else',
    kind: 'text' as const,
    body,
    createdAt: 0,
  })
  const channel = { id: 'c', name: 'general', kind: 'public' as const }
  const sam = { id: 's', name: 'Sam', department: 'Lighting' }

  it('reaches everyone in the department, as their own name does, even muted', () => {
    for (const level of ['mentions', 'muted'] as const) {
      expect(
        messageAlertKind({
          message: message('@lighting house to half please'),
          channel,
          person: sam,
          level,
          readSeq: 0,
        })
      ).toBe('mention')
    }
  })

  it('needs the whole name, and leaves people in other departments alone', () => {
    expect(isMentioned('@lightingdesk is down', 'Sam', 'Lighting')).toBe(false)
    expect(isMentioned('@Lighting, standby', 'Sam', 'Lighting')).toBe(true)
    expect(isMentioned('@Lighting, standby', 'Sam', 'Sound')).toBe(false)
    expect(isMentioned('@Lighting, standby', 'Sam')).toBe(false)
  })
})

describe('unlock tokens bound to a person', () => {
  it('open only for that person, and go when they are revoked', () => {
    const tokens = new AdminTokens(60_000)
    const sams = tokens.issue('sam')
    const anyones = tokens.issue()
    expect(tokens.valid(sams, 'sam')).toBe(true)
    expect(tokens.valid(sams, 'alex')).toBe(false)
    expect(tokens.valid(anyones, 'alex')).toBe(true)

    tokens.revokeUser('sam')
    expect(tokens.valid(sams, 'sam')).toBe(false)
    expect(tokens.valid(anyones, 'alex')).toBe(true)
  })
})
