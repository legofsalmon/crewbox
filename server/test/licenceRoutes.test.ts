import { generateKeyPairSync, sign as signWith } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { attachWs, buildApp, type App } from '../src/app.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { hashPin } from '../src/auth.ts'
import { machineHash, type LicenceFetch } from '../src/licence/sdk.ts'
import { LicenceService, TOKEN_SETTING } from '../src/licence/service.ts'
import type { LicencePolicy } from '../src/licence/decide.ts'

/**
 * The licence over HTTP, which is where "admin-only" and "never touches the
 * crew" are actually kept.
 *
 * The rule under test more than any other: under every policy, an unlicensed
 * box lets crew join, talk and read exactly as a licensed one does. The most
 * a policy may do is mark the admin console and the drawer, or — under
 * `lock` — refuse to configure an event.
 */

const EVENT_PIN = '9999'
const ADMIN_PASSWORD = 'let-me-in-please'
const FINGERPRINT = 'TEST-BOX-0001'
const HASH = machineHash(FINGERPRINT)

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  .subarray(-32)
  .toString('hex')

const mint = (over: Record<string, unknown> = {}): string => {
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      key: 'LT-CREW-AAAA-BBBB-CCCC',
      product: 'crewbox',
      edition: 'standard',
      customer: 'c',
      seats: 1,
      maintUntil: now + 365 * 86_400,
      exp: now + 90 * 86_400,
      machine: HASH,
      mode: 'offline',
      iat: now,
      jti: 'j',
      ...over,
    })
  ).toString('base64url')
  return `${payload}.${signWith(null, Buffer.from(payload), privateKey).toString('base64url')}`
}

/** The licence service, answering the way it does when it says no. */
const refusing: LicenceFetch = async () => ({
  ok: false,
  status: 403,
  json: async () => ({ ok: false, reason: 'revoked', message: 'This licence was revoked.' }),
})

const apps: App[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

function newApp(policy: LicencePolicy = 'watermark', fetch: LicenceFetch = refusing) {
  const store = new Store(openDb(':memory:'))
  store.createChannel('general', 'public', 'Everyone')
  // Stored rather than ADMIN_PASSWORD, so the panel is allowed to change it —
  // which one of the lock tests needs to prove is never locked.
  store.setSetting('adminPasswordHash', hashPin(ADMIN_PASSWORD))
  const licence = new LicenceService({
    settings: store,
    fingerprint: FINGERPRINT,
    buildDate: 0,
    publicKeyHex: PUB,
    policy,
    fetch,
  })
  const app = buildApp({
    store,
    eventPin: EVENT_PIN,
    licence,
    outbound: false,
    logger: false,
  })
  apps.push(app)
  return { app, store, licence }
}

const join = async (app: App, name: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, eventPin: EVENT_PIN, personalPin: '1234' },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { token: string }).token
}

const asAdmin = async (app: App) => {
  const token = await join(app, 'Alex')
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/unlock',
    headers: { authorization: `Bearer ${token}` },
    payload: { password: ADMIN_PASSWORD },
  })
  const adminToken = (res.json() as { adminToken: string }).adminToken
  return { authorization: `Bearer ${token}`, 'x-admin-token': adminToken }
}

describe('who may see and change the licence', () => {
  it('turns away no session, and a crew member without the admin password', async () => {
    const { app } = newApp()
    const crew = await join(app, 'Sam')
    for (const [method, url] of [
      ['GET', '/api/admin/licence'],
      ['POST', '/api/admin/licence/activate'],
      ['POST', '/api/admin/licence/trial'],
      ['POST', '/api/admin/licence/token'],
      ['POST', '/api/admin/licence/check-in'],
      ['POST', '/api/admin/licence/release'],
    ] as const) {
      const anon = await app.inject({ method, url, payload: {} })
      expect(anon.statusCode, `${url} with no session`).toBe(401)
      const plain = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${crew}` },
        payload: {},
      })
      expect(plain.statusCode, `${url} without the unlock`).toBe(403)
    }
  })

  it('shows an admin the status and the request code', async () => {
    const { app } = newApp()
    const res = await app.inject({ url: '/api/admin/licence', headers: await asAdmin(app) })
    expect(res.statusCode).toBe(200)
    const { licence } = res.json() as {
      licence: { status: string; requestCode: string; machine: string; watermark: boolean }
    }
    expect(licence).toMatchObject({
      status: 'invalid',
      requestCode: FINGERPRINT,
      machine: HASH,
      watermark: true,
    })
  })

  it('never puts the key, the token or the request code in what phones get', async () => {
    const { app, licence } = newApp()
    licence.acceptToken(mint())
    const config = await app.inject({ url: '/api/config' })
    expect(config.body).not.toContain(FINGERPRINT)
    expect(config.body).not.toContain('LT-CREW')
    expect(config.body).not.toContain(HASH)
  })
})

describe('refusals come back as something the panel can show', () => {
  it("passes the service's message through as 422, never as the 403 that means 'unlock lost'", async () => {
    const { app } = newApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/licence/activate',
      headers: await asAdmin(app),
      payload: { key: 'LT-CREW-AAAA-BBBB-CCCC' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: 'This licence was revoked.', reason: 'revoked' })
  })

  it('takes a pasted offline token and marks the box licensed', async () => {
    const { app } = newApp()
    const headers = await asAdmin(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/licence/token',
      headers,
      payload: { token: mint() },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { licence: { status: string } }).licence.status).toBe('active')
    const config = (await app.inject({ url: '/api/config' })).json() as { unlicensed?: boolean }
    expect(config.unlicensed).toBeUndefined()
  })

  it("refuses another box's token with the reason", async () => {
    const { app, store } = newApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/licence/token',
      headers: await asAdmin(app),
      payload: { token: mint({ machine: machineHash('ANOTHER-BOX') }) },
    })
    expect(res.statusCode).toBe(422)
    expect((res.json() as { error: string }).error).toMatch(/another machine/)
    expect(store.getSetting(TOKEN_SETTING)).toBeUndefined()
  })

  it('releases even with no network, and the mark comes back', async () => {
    const offline: LicenceFetch = async () => {
      throw new TypeError('fetch failed')
    }
    const { app, licence } = newApp('watermark', offline)
    licence.acceptToken(mint())
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/licence/release',
      headers: await asAdmin(app),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ released: false, licence: { status: 'invalid' } })
    const config = (await app.inject({ url: '/api/config' })).json() as { unlicensed?: boolean }
    expect(config.unlicensed).toBe(true)
  })
})

describe('the marks', () => {
  it('tells phones the box is unlicensed under watermark', async () => {
    const { app } = newApp('watermark')
    expect((await app.inject({ url: '/api/config' })).json() as object).toMatchObject({
      unlicensed: true,
    })
  })

  it('says nothing at all under open', async () => {
    const { app } = newApp('open')
    const config = (await app.inject({ url: '/api/config' })).json() as { unlicensed?: boolean }
    expect(config.unlicensed).toBeUndefined()
  })

  it('says nothing on a box built without licensing wired in', async () => {
    const store = new Store(openDb(':memory:'))
    const app = buildApp({ store, eventPin: EVENT_PIN, outbound: false, logger: false })
    apps.push(app)
    const config = (await app.inject({ url: '/api/config' })).json() as { unlicensed?: boolean }
    expect(config.unlicensed).toBeUndefined()
  })

  it('pushes the change to connected phones the moment a licence is entered', async () => {
    const { app, licence } = newApp('watermark')
    const token = await join(app, 'Sam')
    await app.listen({ port: 0, host: '127.0.0.1' })
    attachWs(app)
    const port = (app.server.address() as { port: number }).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const configs: Array<{ unlicensed?: boolean }> = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; config?: { unlicensed?: boolean } }
      if (msg.type === 'welcome' || msg.type === 'config') configs.push(msg.config ?? {})
    })
    await new Promise((resolve) => ws.once('open', resolve))
    ws.send(JSON.stringify({ type: 'hello', token, cursors: {} }))
    await expect.poll(() => configs.length).toBe(1)
    expect(configs[0].unlicensed).toBe(true)

    licence.acceptToken(mint())
    await expect.poll(() => configs.length).toBe(2)
    expect(configs[1].unlicensed).toBeUndefined()
    ws.close()
  })
})

describe('crew comms are never blocked or degraded, under any policy', () => {
  for (const policy of ['open', 'watermark', 'lock'] as const) {
    it(`an unlicensed box under ${policy} lets crew join, search and read history`, async () => {
      const { app, store } = newApp(policy)
      const token = await join(app, 'Sam')
      const auth = { authorization: `Bearer ${token}` }
      expect((await app.inject({ url: '/api/me', headers: auth })).statusCode).toBe(200)
      expect((await app.inject({ url: '/api/search?q=hi', headers: auth })).statusCode).toBe(200)
      const general = store.getChannelByName('general')!
      const history = await app.inject({
        url: `/api/channels/${general.id}/messages`,
        headers: auth,
      })
      expect(history.statusCode).toBe(200)
    })
  }
})

describe('the lock policy', () => {
  it('refuses to configure the event, and says where the licence goes', async () => {
    const { app } = newApp('lock')
    const headers = await asAdmin(app)
    for (const payload of [
      { eventName: 'Ashton Court' },
      { wifiSsid: 'CrewNet' },
      { crewIface: '' },
      { dmxMode: 'sacn' },
    ]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/settings',
        headers,
        payload,
      })
      expect(res.statusCode, JSON.stringify(payload)).toBe(423)
      expect((res.json() as { error: string }).error).toMatch(/Admin → Licence/)
    }
  })

  it('never locks the event PIN or the admin password — those are how you shut somebody out', async () => {
    const { app } = newApp('lock')
    const headers = await asAdmin(app)
    const pin = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { eventPin: '24682468' },
    })
    expect(pin.statusCode).toBe(200)
    const password = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { adminPassword: 'a-brand-new-one' },
    })
    expect(password.statusCode).toBe(200)
  })

  it('unlocks the moment a licence is entered', async () => {
    const { app, licence } = newApp('lock')
    const headers = await asAdmin(app)
    licence.acceptToken(mint())
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers,
      payload: { eventName: 'Ashton Court' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('withholds first-run setup, and shows what is needed to reach the Licence section', async () => {
    const { app, store } = newApp('lock')
    const page = await app.inject({ url: '/setup' })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Licence needed')
    expect(page.body).not.toContain('<form')
    expect(page.body).toContain(EVENT_PIN)

    const post = await app.inject({
      method: 'POST',
      url: '/setup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ eventName: 'Sneaky', eventPin: '1111' }).toString(),
    })
    expect(post.statusCode).toBe(423)
    expect(store.getSetting('eventName')).toBeUndefined()
  })

  it('leaves configuration alone under watermark', async () => {
    const { app } = newApp('watermark')
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: await asAdmin(app),
      payload: { eventName: 'Ashton Court' },
    })
    expect(res.statusCode).toBe(200)
    const page = await app.inject({ url: '/setup' })
    // somebody joined, so setup is closed as it always is — not locked
    expect(page.statusCode).toBe(302)
  })
})
