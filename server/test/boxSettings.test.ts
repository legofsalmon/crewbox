import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { buildApp, type App, type AppDeps } from '../src/app.ts'
import { boxTunables } from '../src/config.ts'
import { boxLookup, boxSettingKey } from '../src/boxSettings.ts'

/**
 * Settings that used to exist only as environment variables, chosen in the
 * admin panel instead. Asked for by the person running a box from the Mac
 * menu bar, which has no terminal to set a variable in.
 *
 * What this suite defends: a saved value is read by exactly the code that
 * reads the variable, the environment still wins, and a bad value is refused
 * before anything is saved.
 */

const EVENT_PIN = '9999'
const ADMIN_PASSWORD = 'box-settings-pass'
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

beforeEach(() => {
  dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-boxset-'))
  db = openDb(':memory:')
  store = new Store(db)
  store.createChannel('general', 'public', 'Everyone')
})

afterEach(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

const adminAuth = async (): Promise<Record<string, string>> => {
  const joined = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name: 'Box Admin', eventPin: EVENT_PIN, personalPin: '1234' },
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

interface Payload {
  settings: Record<string, { saved?: string; fromEnv: boolean; boot?: string }>
  restartNeeded: boolean
  modules: string[]
}

describe('reading a saved setting at startup', () => {
  it('parses a saved value exactly as it parses the variable', () => {
    store.setSetting(boxSettingKey('CREWBOX_MODULES'), 'schedule, patch')
    store.setSetting(boxSettingKey('CREWBOX_WATCH'), '1')
    store.setSetting(boxSettingKey('CREWBOX_TZ'), 'Europe/Dublin')
    store.setSetting(boxSettingKey('CREWBOX_UPDATE_CHECK'), '0')
    store.setSetting(boxSettingKey('CREWBOX_CAPTIVE_PORT'), '8880')
    const tuned = boxTunables(boxLookup(store, {}))
    expect(tuned.modules).toEqual(['chat', 'schedule', 'patch'])
    expect(tuned.watch.enabled).toBe(true)
    expect(tuned.timeZone).toBe('Europe/Dublin')
    expect(tuned.updateCheck).toBe(false)
    expect(tuned.captive).toEqual({ enabled: undefined, port: 8880, portFromEnv: true })
  })

  it('lets the environment outrank a saved value', () => {
    store.setSetting(boxSettingKey('CREWBOX_MODULES'), 'schedule')
    const tuned = boxTunables(boxLookup(store, { CREWBOX_MODULES: 'video' }))
    expect(tuned.modules).toEqual(['chat', 'video'])
  })

  it('keeps an empty module list meaning a chat-only box', () => {
    store.setSetting(boxSettingKey('CREWBOX_MODULES'), '')
    expect(boxTunables(boxLookup(store, {})).modules).toEqual(['chat'])
  })

  it('reads nothing but box settings from the store', () => {
    store.setSetting('eventPin', '5555')
    expect(boxLookup(store, {})('eventPin')).toBeUndefined()
  })
})

describe('the panel', () => {
  it('shows every setting, with the ones the environment pins marked', async () => {
    app = build({
      boxSettings: { boot: { CREWBOX_WATCH: '1' }, fromEnv: ['CREWBOX_WATCH'] },
    })
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/box-settings',
      headers: await adminAuth(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Payload
    expect(body.settings.CREWBOX_WATCH).toEqual({ fromEnv: true, boot: '1' })
    expect(body.settings.CREWBOX_TZ).toEqual({ fromEnv: false })
    expect(body.modules).toContain('video')
    expect(body.restartNeeded).toBe(false)
  })

  it('saves, says a restart is due, and clears back to the default', async () => {
    app = build({ boxSettings: { boot: {}, fromEnv: [] } })
    const headers = await adminAuth()
    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/admin/box-settings',
      headers,
      payload: { values: { CREWBOX_TZ: ' Europe/Dublin ', CREWBOX_MODULES: 'schedule' } },
    })
    expect(saved.statusCode).toBe(200)
    const body = saved.json() as Payload
    expect(body.settings.CREWBOX_TZ?.saved).toBe('Europe/Dublin')
    expect(body.restartNeeded).toBe(true)
    expect(store.getSetting(boxSettingKey('CREWBOX_MODULES'))).toBe('schedule')

    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/admin/box-settings',
      headers,
      payload: { values: { CREWBOX_TZ: null, CREWBOX_MODULES: null } },
    })
    expect((cleared.json() as Payload).restartNeeded).toBe(false)
    expect(store.getSetting(boxSettingKey('CREWBOX_TZ'))).toBeUndefined()
  })

  it('refuses a bad value and saves none of the form', async () => {
    app = build({ boxSettings: { boot: {}, fromEnv: [] } })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/box-settings',
      headers: await adminAuth(),
      payload: { values: { CREWBOX_WATCH: '1', CREWBOX_TZ: 'Mars/Olympus' } },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { setting: string }).setting).toBe('CREWBOX_TZ')
    expect(store.getSetting(boxSettingKey('CREWBOX_WATCH'))).toBeUndefined()
  })

  it.each([
    ['CREWBOX_MODULES', 'schedule,karaoke'],
    ['CREWBOX_WATCH_IFACE', '10.0.0.300'],
    ['CREWBOX_CAPTIVE_PORT', '70000'],
    ['SESSION_TTL_DAYS', '0'],
    ['CREWBOX_UPDATE_CHECK', 'yes'],
  ])('refuses %s=%s', async (name, value) => {
    app = build()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/box-settings',
      headers: await adminAuth(),
      payload: { values: { [name]: value } },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses to save over the environment', async () => {
    app = build({ boxSettings: { boot: { CREWBOX_TZ: 'UTC' }, fromEnv: ['CREWBOX_TZ'] } })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/box-settings',
      headers: await adminAuth(),
      payload: { values: { CREWBOX_TZ: 'Europe/Dublin' } },
    })
    expect(res.statusCode).toBe(409)
    expect(store.getSetting(boxSettingKey('CREWBOX_TZ'))).toBeUndefined()
  })

  it('refuses anything that is not a box setting', async () => {
    app = build()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/box-settings',
      headers: await adminAuth(),
      payload: { values: { ADMIN_PASSWORD: 'hunter22222' } },
    })
    expect(res.statusCode).toBe(400)
  })

  it('is closed without the admin password', async () => {
    app = build()
    const res = await app.inject({ method: 'GET', url: '/api/admin/box-settings' })
    expect(res.statusCode).toBe(401)
  })
})
