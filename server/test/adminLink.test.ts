import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { buildApp, type App } from '../src/app.ts'
import {
  AdminLinkKey,
  adminLinkAt,
  adminLinkPath,
  adminLinkUrl,
  clearAdminLink,
  printAdminLink,
  readAdminLink,
  writeAdminLink,
} from '../src/adminLink.ts'
import type { BoxStatus } from '../src/box.ts'

/**
 * The admin link: "Open the admin panel" in the box's own menu, and
 * `crewbox --admin` where there is no menu.
 *
 * A Mac box started from the .app has no console, so the password it prints
 * on first start goes nowhere, and one missed on the setup page was gone.
 * The link is the way in for whoever is at the box. What this suite defends
 * is that it is only that: a key the box's own user can read, good once, and
 * nothing a network position or a guess can stand in for.
 */

const EVENT_PIN = '9999'
let dir: string
let app: App
let published: string[]

const build = (): App =>
  buildApp({
    store: new Store(openDb(':memory:')),
    eventPin: EVENT_PIN,
    adminPassword: 'correct-horse',
    filesDir: dir,
    dataDir: dir,
    logger: false,
    publishAdminLink: (key) => published.push(key),
  })

/** The key the box would have put in the menu's file most recently. */
const current = (): string => published[published.length - 1]!

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-admin-link-'))
  published = []
})

afterEach(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

const joinAs = async (name: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, eventPin: EVENT_PIN, personalPin: '1234' },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { token: string }).token
}

const unlockWithLink = (key: unknown) =>
  app.inject({ method: 'POST', url: '/api/admin/unlock-link', payload: { key } })

const settings = (token: string | undefined, adminToken: string) =>
  app.inject({
    method: 'GET',
    url: '/api/admin/settings',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-admin-token': adminToken,
    },
  })

describe('the link route', () => {
  it('opens the panel with the key the box published', async () => {
    app = build()
    expect(published).toHaveLength(1)
    const res = await unlockWithLink(current())
    expect(res.statusCode).toBe(200)
    const { adminToken } = res.json() as { adminToken: string }
    const token = await joinAs('Alex')
    expect((await settings(token, adminToken)).statusCode).toBe(200)
  })

  it('works once, and publishes a new key for the next click', async () => {
    app = build()
    const first = current()
    expect((await unlockWithLink(first)).statusCode).toBe(200)
    // A link left in a browser's history is dead by the time anyone finds it.
    const again = await unlockWithLink(first)
    expect(again.statusCode).toBe(401)
    expect((again.json() as { error: string }).error).toMatch(/already been used/)
    // The menu reads the file at the moment it is clicked, so it has this one.
    expect(published).toHaveLength(2)
    expect(current()).not.toBe(first)
    expect((await unlockWithLink(current())).statusCode).toBe(200)
  })

  it('refuses a wrong key, and leaves the right one working', async () => {
    app = build()
    const key = current()
    for (const wrong of ['nope', key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A'), `${key}x`]) {
      expect((await unlockWithLink(wrong)).statusCode).toBe(401)
    }
    // A miss must not replace the key: anybody who can reach the box could
    // otherwise break the link in the box's own menu.
    expect(published).toHaveLength(1)
    expect((await unlockWithLink(key)).statusCode).toBe(200)
  })

  it('refuses a request with no key in it', async () => {
    app = build()
    expect((await unlockWithLink(undefined)).statusCode).toBe(401)
    expect((await unlockWithLink(123)).statusCode).toBe(401)
    const empty = await app.inject({ method: 'POST', url: '/api/admin/unlock-link' })
    expect(empty.statusCode).toBe(401)
  })

  it('does not rate-limit, so a tunnel cannot lock the box out of its own menu', async () => {
    // Every tunnel visitor arrives from localhost, where the box's browser is.
    app = build()
    for (let i = 0; i < 25; i++) expect((await unlockWithLink(`guess-${i}`)).statusCode).toBe(401)
    expect((await unlockWithLink(current())).statusCode).toBe(200)
  })

  it('hands back a token that opens nothing without a crew session', async () => {
    // Why the route can skip the session the password route asks for: the
    // page spends the key before anyone has joined, and the unlock still
    // belongs to somebody by the time it is used.
    app = build()
    const { adminToken } = (await unlockWithLink(current())).json() as { adminToken: string }
    expect((await settings(undefined, adminToken)).statusCode).toBe(401)
  })

  it('leaves the password route as it was', async () => {
    app = build()
    const token = await joinAs('Alex')
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/unlock',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'correct-horse' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('republishes the same key when asked, for a box that got its port back', async () => {
    app = build()
    const key = current()
    app.republishAdminLink()
    expect(published).toEqual([key, key])
  })
})

describe('the key', () => {
  it('is long and random', () => {
    const keys = new Set<string>()
    for (let i = 0; i < 50; i++) new AdminLinkKey((key) => keys.add(key))
    expect(keys.size).toBe(50)
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('goes in the fragment, so the box never logs it', () => {
    const url = adminLinkUrl('http://localhost:8787', 'k3y')
    expect(url).toBe('http://localhost:8787/?admin#admin-key=k3y')
    // The part a browser sends in the request carries no key.
    const parsed = new URL(url)
    expect(`${parsed.pathname}${parsed.search}`).not.toContain('k3y')
  })
})

describe('the file the menu reads', () => {
  const link = { pid: process.pid, url: 'http://localhost:8787/?admin#admin-key=abc' }

  it('round-trips', () => {
    writeAdminLink(dir, link)
    expect(readAdminLink(dir)).toEqual(link)
  })

  it.skipIf(process.platform === 'win32')('is readable by the box’s own user only', () => {
    writeAdminLink(dir, link)
    expect(statSync(adminLinkPath(dir)).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')(
    'stays private when it replaces a file anyone could read',
    () => {
      // `mode` only applies to a file that open creates, which is why the
      // link is written to a new file and moved into place.
      writeFileSync(adminLinkPath(dir), '{}', { mode: 0o644 })
      writeAdminLink(dir, link)
      expect(statSync(adminLinkPath(dir)).mode & 0o777).toBe(0o600)
      expect(readAdminLink(dir)).toEqual(link)
    }
  )

  it('is ignored when the box that wrote it is gone', () => {
    // A pid kernels reject as out of range, so it is never somebody's.
    writeAdminLink(dir, { ...link, pid: 0x7fffffff })
    expect(readAdminLink(dir)).toBeNull()
  })

  it('reads as nothing when missing or half-written', () => {
    expect(readAdminLink(dir)).toBeNull()
    writeFileSync(adminLinkPath(dir), '{"pid": 12')
    expect(readAdminLink(dir)).toBeNull()
    writeFileSync(adminLinkPath(dir), '{"pid": "12", "url": 4}')
    expect(readAdminLink(dir)).toBeNull()
  })

  it('is removed on exit by the box that wrote it, and only by that box', () => {
    // Mid-update two boxes share the directory, and the one stopping may be
    // the build that failed, after the old box has put its own link back.
    writeAdminLink(dir, { ...link, pid: 424242 })
    clearAdminLink(dir, 1)
    expect(JSON.parse(readFileSync(adminLinkPath(dir), 'utf8'))).toMatchObject({ pid: 424242 })
    clearAdminLink(dir, 424242)
    expect(() => statSync(adminLinkPath(dir))).toThrow()
  })

  it('is what a running box writes, and gone once it stops', async () => {
    // index.ts's own wiring, reduced: publish into the data directory.
    app = buildApp({
      store: new Store(openDb(':memory:')),
      eventPin: EVENT_PIN,
      filesDir: dir,
      dataDir: dir,
      logger: false,
      publishAdminLink: (key) =>
        writeAdminLink(dir, { pid: process.pid, url: adminLinkUrl('http://localhost:8787', key) }),
    })
    const first = readAdminLink(dir)!
    const key = new URL(first.url).hash.replace('#admin-key=', '')
    expect((await unlockWithLink(key)).statusCode).toBe(200)
    const next = readAdminLink(dir)!
    expect(next.url).not.toBe(first.url)
    clearAdminLink(dir)
    expect(readAdminLink(dir)).toBeNull()
  })
})

describe('crewbox --admin', () => {
  const status = (over: Partial<BoxStatus> = {}): BoxStatus => ({
    pid: process.pid,
    port: 8787,
    secure: false,
    joinUrl: 'http://192.168.1.10:8787',
    urls: ['http://192.168.1.10:8787'],
    eventPin: '4242',
    eventName: 'Test Fest',
    version: '0.20.0',
    ...over,
  })

  const printed = (fn: () => number): { code: number; out: string } => {
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    try {
      return { code: fn(), out: lines.join('\n') }
    } finally {
      log.mockRestore()
    }
  }

  it('prints the link, and the same key at the address crew use', () => {
    writeAdminLink(dir, { pid: process.pid, url: 'http://localhost:8787/?admin#admin-key=abc' })
    const { code, out } = printed(() => printAdminLink(dir, status()))
    expect(code).toBe(0)
    expect(out).toContain('http://localhost:8787/?admin#admin-key=abc')
    // Somebody who ran this over SSH is holding a laptop, not the box.
    expect(out).toContain('http://192.168.1.10:8787/?admin#admin-key=abc')
    expect(out).toMatch(/works once/)
  })

  it('prints one link when the box sends its browser where crew go anyway', () => {
    const url = 'https://chat.example.org:8787/?admin#admin-key=abc'
    writeAdminLink(dir, { pid: process.pid, url })
    const { out } = printed(() =>
      printAdminLink(dir, status({ joinUrl: 'https://chat.example.org:8787' }))
    )
    expect(out.split(url)).toHaveLength(2)
    expect(out).not.toMatch(/another device/)
  })

  it('says so when no box is running', () => {
    const { code, out } = printed(() => printAdminLink(dir, null))
    expect(code).toBe(1)
    expect(out).toMatch(/No box is running/)
  })

  it('moves a link to another origin and keeps the key', () => {
    expect(adminLinkAt('http://localhost:8787/?admin#admin-key=abc', 'https://10.0.0.2:8787')).toBe(
      'https://10.0.0.2:8787/?admin#admin-key=abc'
    )
    expect(adminLinkAt('http://localhost:8787/?admin#admin-key=abc', 'http://localhost:8787')).toBe(
      null
    )
    expect(adminLinkAt('not a url', 'http://localhost:8787')).toBeNull()
  })
})
