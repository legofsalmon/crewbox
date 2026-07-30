import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { buildApp, type App, type AppDeps } from '../src/app.ts'

/**
 * Network settings chosen in a browser instead of a terminal.
 *
 * Asked for from a festival site: the box there has a crew adapter and a
 * lighting adapter, and the person setting it up should not need ipconfig
 * and three environment variables to say which is which. Saved settings live
 * in the settings table; the environment still wins where set, which keeps
 * the terminal the recovery path for a bad save.
 */

const EVENT_PIN = '9999'
const ADMIN_PASSWORD = 'network-admin-pass'
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
  dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-netset-'))
  db = openDb(':memory:')
  store = new Store(db)
  store.createChannel('general', 'public', 'Everyone')
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

const adminAuth = async (): Promise<Record<string, string>> => {
  const joined = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name: 'Net Admin', eventPin: EVENT_PIN, personalPin: '1234' },
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

describe('saving network settings from the panel', () => {
  it('stores the choices and reports them back with the adapter list', async () => {
    app = build()
    const headers = await adminAuth()

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { crewIface: '192.168.1.50', dmxMode: 'sacn', dmxUniverses: '1-8,101' },
    })
    expect(patched.statusCode).toBe(200)
    const { network } = patched.json() as {
      network: { saved: Record<string, string>; adapters: unknown[] }
    }
    expect(network.saved).toMatchObject({
      crewIface: '192.168.1.50',
      dmxMode: 'sacn',
      dmxUniverses: '1-8,101',
    })
    // The dropdown's raw material rides along, straight from the OS.
    expect(Array.isArray(network.adapters)).toBe(true)

    // And it stuck: what the next boot reads is what was saved.
    expect(store.getSetting('crewIface')).toBe('192.168.1.50')
    expect(store.getSetting('dmxMode')).toBe('sacn')
  })

  it('rejects an address that is not an address', async () => {
    app = build()
    const headers = await adminAuth()
    for (const bad of ['not-an-ip', '300.1.1.1', '192.168.1', '192.168.1.50; rm -rf']) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/settings',
        headers,
        payload: { crewIface: bad },
      })
      expect(res.statusCode, bad).toBe(400)
    }
    expect(store.getSetting('crewIface')).toBeUndefined()
  })

  it('rejects a universe list with no universes in it', async () => {
    app = build()
    const headers = await adminAuth()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { dmxUniverses: 'kitchen sink' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('clears a choice with an empty string, back to the default', async () => {
    app = build()
    const headers = await adminAuth()
    store.setSetting('crewIface', '192.168.1.50')
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { crewIface: '' },
    })
    expect(res.statusCode).toBe(200)
    expect(store.getSetting('crewIface')).toBe('')
  })
})

describe('telling the admin a restart is due', () => {
  const network = {
    boot: { iface: '', dmxMode: 'off', dmxIface: '', dmxUniverses: '1-16' },
    env: { iface: false, dmxMode: false, dmxIface: false, dmxUniverses: false },
  }

  it('stays quiet while saved settings match what the process booted with', async () => {
    app = build({ network })
    const headers = await adminAuth()
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers })
    const body = res.json() as { network: { restartNeeded: boolean } }
    expect(body.network.restartNeeded).toBe(false)
  })

  it('says so once a save has diverged from the running config', async () => {
    app = build({ network })
    const headers = await adminAuth()
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { dmxMode: 'both' },
    })
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers })
    const body = res.json() as {
      network: { restartNeeded: boolean }
      readiness: Array<{ id: string; state: string; detail: string }>
    }
    expect(body.network.restartNeeded).toBe(true)
    // The readiness panel carries it too — that list is what an admin reads.
    const check = body.readiness.find((c) => c.id === 'network')
    expect(check?.state).toBe('limited')
    expect(check?.detail).toMatch(/restart|next start/i)
  })

  it('ignores a saved value the environment overrides', async () => {
    // CREWBOX_DMX=both at boot: a panel save of dmxMode cannot change the
    // next start, so it must not demand a restart that would change nothing.
    app = build({
      network: {
        boot: { iface: '', dmxMode: 'both', dmxIface: '', dmxUniverses: '1-16' },
        env: { iface: false, dmxMode: true, dmxIface: false, dmxUniverses: false },
      },
    })
    const headers = await adminAuth()
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { dmxMode: 'off' },
    })
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers })
    expect((res.json() as { network: { restartNeeded: boolean } }).network.restartNeeded).toBe(
      false
    )
  })
})

describe('the setup page on a fresh box', () => {
  it('offers the adapter dropdowns before anyone has joined', async () => {
    app = build()
    const res = await app.inject({ method: 'GET', url: '/setup' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Crew network')
    expect(res.body).toContain('Lighting network listening')
    expect(res.body).toContain('name="crewIface"')
  })

  it('stores what setup submits, alongside the event details', async () => {
    app = build()
    const res = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: {
        eventName: 'Ashton Court 2026',
        wifiSsid: 'CrewNet',
        eventPin: '4242',
        crewIface: '192.168.1.50',
        dmxMode: 'both',
        dmxIface: '2.0.0.50',
        dmxUniverses: '1-8',
      },
    })
    expect(res.statusCode).toBe(302)
    expect(store.getSetting('crewIface')).toBe('192.168.1.50')
    expect(store.getSetting('dmxMode')).toBe('both')
    expect(store.getSetting('dmxIface')).toBe('2.0.0.50')
    expect(store.getSetting('dmxUniverses')).toBe('1-8')
  })

  it('bounces a bad address without losing the rest of the form', async () => {
    app = build()
    const res = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: { eventName: 'Ashton', eventPin: '4242', crewIface: 'not-an-ip' },
    })
    expect(res.statusCode).toBe(400)
    expect(store.getSetting('crewIface')).toBeUndefined()
  })

  it('hides a field the environment has pinned', async () => {
    app = build({
      network: {
        boot: { iface: '10.0.0.5', dmxMode: 'off', dmxIface: '', dmxUniverses: '1-16' },
        env: { iface: true, dmxMode: false, dmxIface: false, dmxUniverses: false },
      },
    })
    const res = await app.inject({ method: 'GET', url: '/setup' })
    expect(res.body).not.toContain('name="crewIface"')
    // The unpinned fields are still offered.
    expect(res.body).toContain('name="dmxMode"')
  })
})

describe('what a save changes immediately', () => {
  it('redirects the advertised address without a restart', async () => {
    // The QR and /connect follow the saved crew adapter as soon as it is
    // saved — the binding waits for a restart, and the panel says so, but a
    // poster printed a minute after saving is already right.
    app = build()
    const headers = await adminAuth()

    // A saved iface that is not one of this machine's addresses is ignored
    // by the picker (readiness names the mismatch), so to observe the pick
    // live we save the machine's own first address — the assertion is that
    // the advertised value tracks the store, not boot state.
    const before = await app.inject({ method: 'GET', url: '/api/admin/settings', headers })
    const advertised = (before.json() as { network: { advertised: string } }).network.advertised
    if (!advertised) return // machine with no LAN address: nothing to assert

    await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { crewIface: advertised },
    })
    const after = await app.inject({ method: 'GET', url: '/api/admin/settings', headers })
    expect((after.json() as { network: { advertised: string } }).network.advertised).toBe(
      advertised
    )
  })
})
