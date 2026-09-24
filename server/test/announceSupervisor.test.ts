import { mkdtempSync, rmSync } from 'node:fs'
import type { NetworkInterfaceInfo } from 'node:os'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { buildApp, type App, type AppDeps } from '../src/app.ts'
import {
  ANNOUNCE_KEY,
  Announcements,
  type AnnounceSetting,
  type AnnouncerLike,
  type AnnouncementsOptions,
} from '../src/announce/index.ts'
import type { AnnouncerOptions, ServiceDetails } from '../src/announce/responder.ts'

/**
 * Keeping one announcer on the right adapter, and the admin panel's view of
 * it. The responder itself is stood in for: what is under test is when it
 * is started, moved, retried and stopped, and what the panel is told.
 */

class StandIn implements AnnouncerLike {
  state = 'idle'
  error: string | null = null
  refreshed = 0
  stopped = false
  constructor(
    readonly options: AnnouncerOptions,
    private readonly fail: Error | null
  ) {}
  get instanceName(): string {
    return this.options.details().eventName || 'crewbox'
  }
  start(): Promise<void> {
    if (this.fail) {
      this.state = 'failed'
      return Promise.reject(this.fail)
    }
    this.state = 'announced'
    return Promise.resolve()
  }
  refresh(): void {
    this.refreshed++
  }
  stop(): Promise<void> {
    this.stopped = true
    this.state = 'stopped'
    return Promise.resolve()
  }
}

const v4 = (address: string, netmask = '255.255.255.0'): NetworkInterfaceInfo => ({
  address,
  netmask,
  family: 'IPv4',
  mac: '00:11:22:33:44:55',
  internal: false,
  cidr: null,
})

let adapters: Record<string, NetworkInterfaceInfo[]>
let setting: AnnounceSetting
let details: ServiceDetails
let made: StandIn[]
let failNext: Error | null
let logs: string[]

const supervise = (over: Partial<AnnouncementsOptions> = {}) =>
  new Announcements({
    setting: () => setting,
    fromEnv: false,
    crewIface: '',
    watchers: [],
    port: 8787,
    details: () => details,
    interfaces: () => adapters,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn: ${m}`) },
    createAnnouncer: (options) => {
      const a = new StandIn(options, failNext)
      made.push(a)
      return a
    },
    intervalMs: 15_000,
    ...over,
  })

beforeEach(() => {
  vi.useFakeTimers()
  adapters = { en0: [v4('10.0.0.2')] }
  setting = 'auto'
  details = {
    eventId: 'evt',
    eventName: 'Fest',
    version: '1',
    protocol: 1,
    setUp: true,
    tls: false,
  }
  made = []
  failNext = null
  logs = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('keeping the box announced', () => {
  it('announces on the crew adapter and says so', async () => {
    const s = supervise()
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(made).toHaveLength(1)
    expect(made[0]?.options).toMatchObject({
      address: '10.0.0.2',
      netmask: '255.255.255.0',
      port: 8787,
    })
    expect(s.status()).toEqual({
      state: 'announcing',
      setting: 'auto',
      fromEnv: false,
      address: '10.0.0.2',
      adapter: 'en0',
      name: 'Fest',
    })
    await s.stop()
  })

  it('stays quiet, and says why, where it may not speak', async () => {
    adapters = { en0: [v4('10.0.0.2')], en1: [v4('2.0.0.10', '255.0.0.0')] }
    const s = supervise()
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(made).toHaveLength(0)
    expect(s.status()).toMatchObject({
      state: 'quiet',
      reason: expect.stringMatching(/crew network/),
    })
    await s.stop()
  })

  it('follows the adapter: gone takes the announcement with it, back brings it back', async () => {
    const s = supervise({ crewIface: '10.0.0.2' })
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(made).toHaveLength(1)

    adapters = {}
    await vi.advanceTimersByTimeAsync(15_000)
    expect(made[0]?.stopped).toBe(true)
    expect(s.status().state).toBe('quiet')

    adapters = { en0: [v4('10.0.0.2')] }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(made).toHaveLength(2)
    expect(s.status().state).toBe('announcing')
    await s.stop()
  })

  it('moves to a new address on the same adapter', async () => {
    const s = supervise()
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    adapters = { en0: [v4('10.0.0.77')] }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(made[0]?.stopped).toBe(true)
    expect(made[1]?.options.address).toBe('10.0.0.77')
    await s.stop()
  })

  it('tries again when the port would not open, and says so once rather than every time', async () => {
    failNext = new Error('bind EADDRINUSE 0.0.0.0:5353')
    const s = supervise()
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.status()).toMatchObject({
      state: 'failed',
      reason: expect.stringMatching(/EADDRINUSE/),
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(made).toHaveLength(3)
    expect(logs.filter((l) => l.startsWith('warn:'))).toHaveLength(1)

    failNext = null
    await vi.advanceTimersByTimeAsync(15_000)
    expect(s.status().state).toBe('announcing')
    // Said at the next look, once packets are actually going out.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(logs.at(-1)).toMatch(/announcing again/)
    await s.stop()
  })

  it('starts again when sending fails later, and says so once', async () => {
    const s = supervise()
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    for (let round = 0; round < 3; round++) {
      const running = made.at(-1)!
      running.state = 'failed'
      running.error = 'send EHOSTUNREACH 224.0.0.251:5353'
      expect(s.status()).toMatchObject({
        state: 'failed',
        reason: expect.stringMatching(/stopped \(send EHOSTUNREACH/),
      })
      await vi.advanceTimersByTimeAsync(15_000)
    }
    expect(made).toHaveLength(4)
    expect(logs.filter((l) => l.startsWith('warn:'))).toHaveLength(1)
    await s.stop()
  })

  it('says again what changed without being asked, within one look', async () => {
    const s = supervise()
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(made[0]?.refreshed).toBe(0)
    details = { ...details, setUp: false }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(made[0]?.refreshed).toBe(1)
    await s.stop()
  })

  it('acts on a changed setting at once when asked to refresh', async () => {
    const s = supervise()
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    setting = 'off'
    await s.refresh()
    expect(made[0]?.stopped).toBe(true)
    expect(s.status()).toMatchObject({ state: 'off' })
    await s.stop()
  })

  it('stops the announcer, with its goodbye, when it stops', async () => {
    const s = supervise()
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    await s.stop()
    expect(made[0]?.stopped).toBe(true)
    // And stays stopped: nothing comes back on the next tick.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(made).toHaveLength(1)
  })
})

describe('the admin panel', () => {
  const EVENT_PIN = '9999'
  const ADMIN_PASSWORD = 'announce-admin-pass'
  let dir: string
  let db: DatabaseSync
  let store: Store
  let app: App

  const build = (over: Partial<AppDeps> = {}): App =>
    buildApp({
      store,
      eventPin: EVENT_PIN,
      adminPassword: ADMIN_PASSWORD,
      filesDir: dir,
      dataDir: dir,
      logger: false,
      ...over,
    })

  const adminAuth = async (): Promise<Record<string, string>> => {
    const joined = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Announce Admin', eventPin: EVENT_PIN, personalPin: '1234' },
    })
    const token = (joined.json() as { token: string }).token
    const unlocked = await app.inject({
      method: 'POST',
      url: '/api/admin/unlock',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: ADMIN_PASSWORD },
    })
    const adminToken = (unlocked.json() as { adminToken: string }).adminToken
    return { authorization: `Bearer ${token}`, 'x-admin-token': adminToken }
  }

  beforeEach(() => {
    vi.useRealTimers()
    dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-announce-'))
    db = openDb(':memory:')
    store = new Store(db)
    store.createChannel('general', 'public', 'Everyone')
  })

  afterEach(async () => {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const standIn = (fromEnv = false) => {
    const calls = { refresh: 0 }
    return {
      calls,
      announce: {
        status: () => ({
          state: 'quiet' as const,
          setting: (store.getSetting(ANNOUNCE_KEY) as AnnounceSetting | undefined) ?? 'auto',
          fromEnv,
          reason: 'Quiet, for the test.',
        }),
        refresh: () => {
          calls.refresh++
        },
        settingFromEnv: fromEnv,
      },
    }
  }

  it('reports whether the box is announcing, with the reason when it is not', async () => {
    const { announce } = standIn()
    app = build({ announce })
    const headers = await adminAuth()
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers })
    expect(res.json().network.announce).toEqual({
      state: 'quiet',
      setting: 'auto',
      fromEnv: false,
      reason: 'Quiet, for the test.',
    })
  })

  it('says nothing about it on a box that does not announce', async () => {
    app = build()
    const headers = await adminAuth()
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers })
    expect(res.json().network).not.toHaveProperty('announce')
  })

  it('saves the choice and acts on it before answering', async () => {
    const { announce, calls } = standIn()
    app = build({ announce })
    const headers = await adminAuth()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { announce: 'off' },
    })
    expect(res.statusCode).toBe(200)
    expect(store.getSetting(ANNOUNCE_KEY)).toBe('off')
    expect(calls.refresh).toBe(1)
    expect(res.json().network.announce.setting).toBe('off')
  })

  it('tells the announcer when the event is renamed, so phones see the new name', async () => {
    const { announce, calls } = standIn()
    app = build({ announce })
    const headers = await adminAuth()
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { eventName: 'Ashton Court 2027' },
    })
    expect(calls.refresh).toBe(1)
  })

  it('refuses a choice the environment makes, and saves nothing', async () => {
    const { announce } = standIn(true)
    app = build({ announce })
    const headers = await adminAuth()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { announce: 'on', eventName: 'Not saved either' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/CREWBOX_ANNOUNCE/)
    expect(store.getSetting(ANNOUNCE_KEY)).toBeUndefined()
    expect(store.getSetting('eventName')).toBeUndefined()
  })

  it('refuses a setting it does not know', async () => {
    const { announce } = standIn()
    app = build({ announce })
    const headers = await adminAuth()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { announce: 'sometimes' },
    })
    expect(res.statusCode).toBe(400)
  })
})
