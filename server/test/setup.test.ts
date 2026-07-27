import { afterEach, describe, expect, it } from 'vitest'
import { buildApp, type App } from '../src/app.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { hashPin } from '../src/auth.ts'
import type { Probes } from '../src/environment.ts'

/**
 * The first-run setup page. Two things carry weight here: that it saves what
 * an admin types before anyone has joined, and that it stops existing the
 * moment someone has — a form that could still rewrite the event PIN
 * mid-event would be a way past the admin panel.
 */

const apps: App[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

const newApp = (probes?: Probes) => {
  const store = new Store(openDb(':memory:'))
  const app = buildApp({ store, eventPin: '1234', logger: false, probes })
  apps.push(app)
  return { app, store }
}

/** Probes with nothing wrong and no internet — a box in a field. */
const offlineProbes = (over: Partial<Probes> = {}): Probes => ({
  tcpReachable: async () => false,
  noContentOk: async () => false,
  resolve4: async () => [],
  localAddresses: () => ['192.168.1.50'],
  certPem: () => null,
  now: () => Date.now(),
  ...over,
})

/** The environment sweep starts at construction; give it a tick to land. */
const settled = () => new Promise((r) => setTimeout(r, 50))

const form = (fields: Record<string, string>) => ({
  method: 'POST' as const,
  url: '/setup',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(fields).toString(),
})

describe('first-run setup', () => {
  it('offers the form while nobody has joined', async () => {
    const { app } = newApp()
    const res = await app.inject({ method: 'GET', url: '/setup' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('name="eventName"')
    expect(res.body).toContain('name="wifiSsid"')
    expect(res.body).toContain('name="eventPin"')
  })

  it('prefills the PIN so an admin can keep the minted one', async () => {
    const { app, store } = newApp()
    store.setSetting('eventPin', '8642')
    const res = await app.inject({ method: 'GET', url: '/setup' })
    expect(res.body).toContain('value="8642"')
  })

  it('saves all three and sends the admin to the QR page', async () => {
    const { app, store } = newApp()
    const res = await app.inject(
      form({ eventName: 'Ashton Court 2026', wifiSsid: 'CrewNet', eventPin: '4321' })
    )
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/connect')
    expect(store.getSetting('eventName')).toBe('Ashton Court 2026')
    expect(store.getSetting('wifiSsid')).toBe('CrewNet')
    expect(store.getSetting('eventPin')).toBe('4321')
  })

  it('closes for good once anyone has joined', async () => {
    // Before this point the LAN can join and become admin anyway, so the open
    // form gives nothing away. After it, the admin panel is the only door.
    const { app, store } = newApp()
    store.createUser('Alex', hashPin('1234'), 'admin')

    const get = await app.inject({ method: 'GET', url: '/setup' })
    expect(get.statusCode).toBe(302)
    expect(get.headers.location).toBe('/connect')

    const post = await app.inject(form({ eventName: 'Hijack', wifiSsid: '', eventPin: '9999' }))
    expect(post.statusCode).toBe(302)
    expect(store.getSetting('eventName')).toBeUndefined()
    expect(store.getSetting('eventPin')).toBeUndefined()
  })

  it('re-renders with what was typed when the PIN is too short', async () => {
    const { app, store } = newApp()
    const res = await app.inject(form({ eventName: 'Glasto', wifiSsid: 'CrewNet', eventPin: '12' }))
    expect(res.statusCode).toBe(400)
    // Losing the other two fields on a bounce is the classic form annoyance.
    expect(res.body).toContain('value="Glasto"')
    expect(res.body).toContain('value="CrewNet"')
    expect(store.getSetting('eventPin')).toBeUndefined()
  })

  it('escapes the event name rather than reflecting markup', async () => {
    const { app } = newApp()
    await app.inject(form({ eventName: '"><script>x</script>', wifiSsid: '', eventPin: '1234' }))
    const res = await app.inject({ method: 'GET', url: '/connect' })
    expect(res.body).not.toContain('<script>x</script>')
    expect(res.body).toContain('&lt;script&gt;')
  })

  it('names the event on the join page once set', async () => {
    const { app } = newApp()
    const plain = await app.inject({ method: 'GET', url: '/connect' })
    expect(plain.body).toContain('<h1>Crewbox</h1>')

    await app.inject(form({ eventName: 'Ashton Court 2026', wifiSsid: '', eventPin: '1234' }))
    const named = await app.inject({ method: 'GET', url: '/connect' })
    expect(named.body).toContain('<h1>Ashton Court 2026</h1>')
  })
})

describe('event name over the API', () => {
  it('reaches clients in the public config', async () => {
    const { app } = newApp()
    await app.inject(form({ eventName: 'Ashton Court 2026', wifiSsid: '', eventPin: '1234' }))
    const res = await app.inject({ method: 'GET', url: '/api/config' })
    expect(res.json()).toMatchObject({ eventName: 'Ashton Court 2026' })
  })
})

describe('environment warnings on the setup page', () => {
  it('stays silent about a box with no internet', async () => {
    // The single most important behaviour in this feature. A festival box has
    // no uplink by design, and greeting a new admin with a warning about the
    // product working as intended would be worse than showing nothing.
    const { app } = newApp(offlineProbes())
    await settled()
    const res = await app.inject({ method: 'GET', url: '/setup' })
    expect(res.body).not.toContain('class="warn"')
  })

  it('warns before setup when no DHCP lease arrived', async () => {
    // Much cheaper to discover here than after the posters are printed.
    const { app } = newApp(offlineProbes({ localAddresses: () => ['169.254.4.4'] }))
    await settled()
    const res = await app.inject({ method: 'GET', url: '/setup' })
    expect(res.body).toContain('class="warn"')
    expect(res.body).toMatch(/no DHCP/)
  })

  it('escapes warning copy rather than reflecting it', async () => {
    const { app } = newApp(
      offlineProbes({ localAddresses: () => ['192.168.1.1', '<script>x</script>'] })
    )
    await settled()
    const res = await app.inject({ method: 'GET', url: '/setup' })
    expect(res.body).not.toContain('<script>x</script>')
  })
})
