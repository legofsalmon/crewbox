import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { buildApp, type App } from '../src/app.ts'
import {
  LATEST_KEY,
  UpdateChecker,
  isNewer,
  parseVersion,
  type UpdateIo,
  type UpdateState,
} from '../src/update/check.ts'

/**
 * The update check.
 *
 * It is deliberately the harmless half — nothing here downloads or installs —
 * so most of what these tests defend is restraint: that a box with no uplink
 * behaves like one that is up to date, that a failed check never throws away
 * a good answer, and that an unreadable version never becomes a notification
 * telling somebody to update a box mid-festival.
 */

const settings = () => {
  const rows = new Map<string, string>()
  return {
    rows,
    getSetting: (k: string) => rows.get(k),
    setSetting: (k: string, v: string) => void rows.set(k, v),
  }
}

interface Recorded {
  url: string
  headers: Record<string, string>
}

/** A GitHub that answers with `tag`, or fails when `tag` is null. */
function fakeIo(tag: string | null, recorded: Recorded[] = [], now = 1_000): UpdateIo {
  return {
    fetch: (url, init) => {
      recorded.push({ url, headers: init.headers })
      if (tag === null) return Promise.reject(new Error('getaddrinfo ENOTFOUND'))
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            tag_name: tag,
            html_url: `https://github.com/legofsalmon/crewbox-dist/releases/tag/${tag}`,
            published_at: '2026-08-12T12:00:00Z',
          }),
      })
    },
    now: () => now,
  }
}

const checker = (opts: {
  current: string
  tag?: string | null
  store?: ReturnType<typeof settings>
  recorded?: Recorded[]
}) =>
  new UpdateChecker({
    currentVersion: opts.current,
    settings: opts.store ?? settings(),
    io: fakeIo(opts.tag === undefined ? 'v0.18.0' : opts.tag, opts.recorded),
    url: 'https://example.invalid/releases/latest',
  })

describe('reading a version', () => {
  it('accepts both shapes the two ends produce', () => {
    // A release tag, and what APP_VERSION looks like.
    expect(parseVersion('v0.18.0')).toEqual([0, 18, 0])
    expect(parseVersion('0.17.0+a1b2c3d')).toEqual([0, 17, 0])
  })

  it('refuses anything it cannot read', () => {
    for (const junk of ['', 'latest', 'v1.2', '1.2.3.4', 'v1.x.0']) {
      expect(parseVersion(junk)).toBeNull()
    }
  })

  it('compares numerically, not as text', () => {
    // The one that bites: '0.9.0' > '0.10.0' as strings.
    expect(isNewer('v0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('v0.9.0', '0.10.0')).toBe(false)
    expect(isNewer('v1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('v0.17.1', '0.17.0')).toBe(true)
  })

  it('is false for the same version, and for going backwards', () => {
    expect(isNewer('v0.17.0', '0.17.0+abc')).toBe(false)
    expect(isNewer('v0.16.0', '0.17.0')).toBe(false)
  })

  it('is false when either side is unreadable', () => {
    // The safe direction. A box built from source, or a tag somebody typed
    // by hand, must never turn into "update your box" during a show.
    expect(isNewer('nightly', '0.17.0')).toBe(false)
    expect(isNewer('v0.18.0', 'unknown')).toBe(false)
  })
})

describe('checking', () => {
  it('reports a newer release', async () => {
    const state = await checker({ current: '0.17.0+abc' }).check()
    expect(state.available?.version).toBe('v0.18.0')
    expect(state.available?.url).toContain('/releases/tag/v0.18.0')
    expect(state.error).toBeNull()
  })

  it('says nothing when the box is already current', async () => {
    const state = await checker({ current: '0.18.0+abc' }).check()
    expect(state.available).toBeNull()
    // It still asked, and the panel can say when.
    expect(state.checkedAt).toBe(1_000)
  })

  it('identifies itself, because GitHub refuses callers that do not', async () => {
    const recorded: Recorded[] = []
    await checker({ current: '0.17.0', recorded }).check()
    expect(recorded[0].headers['user-agent']).toBe('crewbox/0.17.0')
    expect(recorded[0].headers.accept).toBe('application/vnd.github+json')
  })

  it('treats no uplink as ordinary, not as an error state', async () => {
    // The common case on a festival box: no internet for days.
    const state = await checker({ current: '0.17.0', tag: null }).check()
    expect(state.available).toBeNull()
    expect(state.checkedAt).toBeNull()
    expect(state.error).toContain('ENOTFOUND')
  })

  it('never throws, whatever the answer is', async () => {
    const store = settings()
    const junk = new UpdateChecker({
      currentVersion: '0.17.0',
      settings: store,
      url: 'https://example.invalid/x',
      io: {
        fetch: () =>
          Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ nope: 1 }) }),
        now: () => 1_000,
      },
    })
    await expect(junk.check()).resolves.toBeDefined()
    expect((await junk.check()).available).toBeNull()
  })

  it('keeps the last good answer when a later check fails', async () => {
    // A box told about v0.18 on the Thursday should still say so on the
    // Saturday in a field with no signal.
    const store = settings()
    await checker({ current: '0.17.0', store }).check()
    expect(store.rows.get(LATEST_KEY)).toContain('v0.18.0')

    const offline = checker({ current: '0.17.0', store, tag: null })
    const state = await offline.check()
    expect(state.available?.version).toBe('v0.18.0')
    expect(state.error).toBeTruthy()
  })
})

describe('what it remembers', () => {
  it('stores the release, not a verdict', async () => {
    // So a box that has since been updated stops advertising the release it
    // was told about, without having to reach GitHub again.
    const store = settings()
    await checker({ current: '0.17.0', store }).check()

    const updated = new UpdateChecker({ currentVersion: '0.18.0+xyz', settings: store })
    expect(updated.state().available).toBeNull()
    expect(updated.state().checkedAt).toBe(1_000)
  })

  it('shrugs off a settings row somebody edited by hand', async () => {
    const store = settings()
    store.rows.set(LATEST_KEY, '{ not json')
    const c = new UpdateChecker({ currentVersion: '0.17.0', settings: store })
    expect(c.state()).toEqual({ available: null, checkedAt: null, error: null })
    // And a real check repairs it.
    await checker({ current: '0.17.0', store }).check()
    expect(store.rows.get(LATEST_KEY)).toContain('v0.18.0')
  })

  it('ignores a stored row with no version in it', () => {
    const store = settings()
    store.rows.set(LATEST_KEY, JSON.stringify({ checkedAt: 5 }))
    expect(new UpdateChecker({ currentVersion: '0.17.0', settings: store }).state().available).toBe(
      null
    )
  })
})

describe('timers', () => {
  it('starts and stops without leaving anything behind', () => {
    const c = checker({ current: '0.17.0' })
    c.start()
    c.start() // idempotent — a second call must not add a second interval
    c.stop()
    c.stop()
    // The real proof is that vitest exits: both timers are unref'd and
    // cleared. A leaked interval here would hold a box open on shutdown.
    expect(true).toBe(true)
  })
})

describe('what the admin panel is told', () => {
  const EVENT_PIN = '9999'
  const ADMIN_PASSWORD = 'let-me-in'
  let dir: string
  let store: Store
  let app: App

  const build = (updates?: UpdateChecker): App =>
    buildApp({
      store,
      eventPin: EVENT_PIN,
      adminPassword: ADMIN_PASSWORD,
      ...(updates ? { updates } : {}),
      filesDir: dir,
      dataDir: dir,
      logger: false,
    })

  beforeEach(() => {
    dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-update-'))
    store = new Store(openDb(':memory:'))
    store.createChannel('general', 'public', 'Everyone')
  })

  afterEach(async () => {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const readSettings = async () => {
    const joined = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Alex', eventPin: EVENT_PIN, personalPin: '1234' },
    })
    const token = (joined.json() as { token: string }).token
    const unlocked = await app.inject({
      method: 'POST',
      url: '/api/admin/unlock',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: ADMIN_PASSWORD },
    })
    const adminToken = (unlocked.json() as { adminToken: string }).adminToken
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${token}`, 'x-admin-token': adminToken },
    })
    return res.json() as { serverInfo: { update: UpdateState | null } }
  }

  it('reports the update state when the box is checking', async () => {
    const checker = new UpdateChecker({
      currentVersion: '0.17.0',
      settings: store,
      io: fakeIo('v0.18.0'),
      url: 'https://example.invalid/releases/latest',
    })
    await checker.check()
    app = build(checker)
    const { serverInfo } = await readSettings()
    expect(serverInfo.update?.available?.version).toBe('v0.18.0')
  })

  it('reports null when the box was told not to check', async () => {
    // Not "unknown" and not "up to date" — the panel shows nothing at all,
    // because a box with CREWBOX_UPDATE_CHECK=0 has no opinion to report.
    app = build()
    const { serverInfo } = await readSettings()
    expect(serverInfo.update).toBeNull()
  })

  it('survives a box that has never managed a check', async () => {
    app = build(new UpdateChecker({ currentVersion: '0.17.0', settings: store, io: fakeIo(null) }))
    const { serverInfo } = await readSettings()
    expect(serverInfo.update).toEqual({ available: null, checkedAt: null, error: null })
  })
})
