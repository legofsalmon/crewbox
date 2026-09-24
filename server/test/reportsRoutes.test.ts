import { generateKeyPairSync, sign as signWith } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp, type App } from '../src/app.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { hashPin } from '../src/auth.ts'
import { machineHash } from '../src/licence/sdk.ts'
import { LicenceService } from '../src/licence/service.ts'
import { AUTO_SEND_KEY, ReportService, type ReportFetch } from '../src/reports/service.ts'

/**
 * Crash reports and feedback over HTTP: who may queue what, that the box's
 * licence key reaches the studio only when an unlocked admin ticked the box
 * (and never reaches a phone), and that the admin's one-time question is the
 * only way a box crash leaves when automatic sending is off.
 */

const EVENT_PIN = '9999'
const ADMIN_PASSWORD = 'let-me-in-please'
const FINGERPRINT = 'TEST-BOX-0001'
const KEY = 'LT-CREW-AAAA-BBBB-CCCC'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  .subarray(-32)
  .toString('hex')

const token = (): string => {
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      key: KEY,
      product: 'crewbox',
      edition: 'standard',
      customer: 'c',
      seats: 1,
      maintUntil: now + 365 * 86_400,
      exp: now + 90 * 86_400,
      machine: machineHash(FINGERPRINT),
      mode: 'offline',
      iat: now,
      jti: 'j',
    })
  ).toString('base64url')
  return `${payload}.${signWith(null, Buffer.from(payload), privateKey).toString('base64url')}`
}

const apps: App[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Sent {
  url: string
  body: Record<string, unknown>
}

function newApp(opts: { licensed?: boolean; reports?: boolean } = {}) {
  const store = new Store(openDb(':memory:'))
  store.createChannel('general', 'public', 'Everyone')
  store.setSetting('adminPasswordHash', hashPin(ADMIN_PASSWORD))
  const licence = new LicenceService({
    settings: store,
    fingerprint: FINGERPRINT,
    buildDate: 0,
    publicKeyHex: PUB,
    policy: 'watermark',
  })
  if (opts.licensed) licence.acceptToken(token())
  const sent: Sent[] = []
  const fetch: ReportFetch = (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) })
    return Promise.resolve({ status: 202 })
  }
  const dir = mkdtempSync(join(tmpdir(), 'crewbox-report-routes-'))
  dirs.push(dir)
  const reports = new ReportService({
    dir,
    settings: store,
    version: '1.0.0+test',
    outbound: true,
    baseUrl: 'https://intake.example',
    fetch,
  })
  const app = buildApp({
    store,
    eventPin: EVENT_PIN,
    licence,
    ...(opts.reports === false ? {} : { reports }),
    outbound: false,
    logger: false,
  })
  apps.push(app)
  return { app, store, reports, sent }
}

const join_ = async (app: App, name: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, eventPin: EVENT_PIN, personalPin: '1234' },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { token: string }).token
}

const crew = async (app: App, name = 'Sam') => ({
  authorization: `Bearer ${await join_(app, name)}`,
})

const asAdmin = async (app: App) => {
  const headers = await crew(app, 'Alex')
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/unlock',
    headers,
    payload: { password: ADMIN_PASSWORD },
  })
  return { ...headers, 'x-admin-token': (res.json() as { adminToken: string }).adminToken }
}

describe('feedback from a phone', () => {
  it('needs a signed-in session', async () => {
    const { app } = newApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/reports/feedback',
      payload: { type: 'idea', message: 'hi' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('queues what a crew member sends, and it goes as typed', async () => {
    const { app, reports, sent } = newApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/reports/feedback',
      headers: await crew(app),
      payload: { type: 'idea', message: 'A cue light module', os: 'android', public: true },
    })
    expect(res.statusCode).toBe(202)
    await reports.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://intake.example/api/reports/feedback')
    expect(sent[0].body).toMatchObject({
      product: 'crewbox',
      type: 'idea',
      message: 'A cue light module',
      os: 'android',
      public: true,
    })
    // The crew member's name is not in it: nobody typed it into the form.
    expect(JSON.stringify(sent[0].body)).not.toContain('Sam')
  })

  it('refuses nonsense with a reason a person can read', async () => {
    const { app } = newApp()
    const headers = await crew(app)
    for (const payload of [
      { type: 'rant', message: 'x' },
      { type: 'bug', message: '   ' },
      { type: 'bug', message: 'x'.repeat(5001) },
      { type: 'bug', message: 'x', email: 'not-an-email' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/reports/feedback',
        headers,
        payload,
      })
      expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400)
    }
  })

  it('lets only an unlocked admin include the licence, and adds the key on the box', async () => {
    const { app, reports, sent } = newApp({ licensed: true })
    const plain = await app.inject({
      method: 'POST',
      url: '/api/reports/feedback',
      headers: await crew(app),
      payload: { type: 'bug', message: 'x', includeLicence: true },
    })
    expect(plain.statusCode).toBe(403)

    const admin = await app.inject({
      method: 'POST',
      url: '/api/reports/feedback',
      headers: await asAdmin(app),
      payload: { type: 'bug', message: 'from the admin', includeLicence: true },
    })
    expect(admin.statusCode).toBe(202)
    // The phone never saw it...
    expect(admin.body).not.toContain(KEY)
    // ...and the studio did.
    await reports.flush()
    expect(sent.at(-1)?.body.licence).toBe(KEY)
  })

  it('says so when there is no licence to include', async () => {
    const { app } = newApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/reports/feedback',
      headers: await asAdmin(app),
      payload: { type: 'bug', message: 'x', includeLicence: true },
    })
    expect(res.statusCode).toBe(409)
  })

  it('leaves the licence out when the box was not asked to include it', async () => {
    const { app, reports, sent } = newApp({ licensed: true })
    await app.inject({
      method: 'POST',
      url: '/api/reports/feedback',
      headers: await asAdmin(app),
      payload: { type: 'praise', message: 'Worked all weekend' },
    })
    await reports.flush()
    expect(sent[0].body).not.toHaveProperty('licence')
  })

  it('is not there at all on a box built without reports', async () => {
    const { app } = newApp({ reports: false })
    const res = await app.inject({
      method: 'POST',
      url: '/api/reports/feedback',
      headers: await crew(app),
      payload: { type: 'idea', message: 'x' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('a crash a phone reports', () => {
  it('is queued as sent-by-a-person and keeps the phone’s own version', async () => {
    const { app, reports, sent } = newApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/reports/crash',
      headers: await crew(app),
      payload: {
        summary: 'TypeError: cannot read properties of undefined',
        detail: 'at render (https://box.local/assets/app.js?v=3:1:2)',
        version: '1.0.0+abc1234',
        os: 'ios',
        osVersion: '18.6',
      },
    })
    expect(res.statusCode).toBe(202)
    await reports.flush()
    expect(sent[0].url).toBe('https://intake.example/api/reports/crash')
    expect(sent[0].body).toMatchObject({
      kind: 'exception',
      version: '1.0.0+abc1234',
      os: 'ios',
      osVersion: '18.6',
    })
    // Scrubbed on the box as well as the phone.
    expect(sent[0].body.detail).toBe('at render (https://box.local/assets/app.js)')
  })

  it('needs a session', async () => {
    const { app } = newApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/reports/crash',
      payload: { summary: 'x', version: '1', os: 'web' },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('the admin side', () => {
  it('is admin-only', async () => {
    const { app } = newApp()
    const headers = await crew(app)
    for (const [method, url] of [
      ['GET', '/api/admin/reports'],
      ['PATCH', '/api/admin/reports'],
      ['POST', '/api/admin/reports/decide'],
      ['POST', '/api/admin/reports/send'],
    ] as const) {
      const res = await app.inject({ method, url, headers, payload: {} })
      expect(res.statusCode, url).toBe(403)
    }
  })

  it('starts with automatic sending off, and a box crash waits for the question', async () => {
    const { app, reports, sent } = newApp()
    reports.recordCrash({ kind: 'unclean-exit', summary: 'Crewbox 1.0.0 closed unexpectedly' })
    await reports.flush()
    expect(sent).toEqual([])
    const res = await app.inject({ url: '/api/admin/reports', headers: await asAdmin(app) })
    const { reports: summary } = res.json() as {
      reports: { autoSend: boolean; pending: Array<{ kind: string }> }
    }
    expect(summary.autoSend).toBe(false)
    expect(summary.pending).toEqual([expect.objectContaining({ kind: 'unclean-exit' })])
  })

  it('sends on Send, and turns automatic sending on only with the tick', async () => {
    const { app, store, reports, sent } = newApp()
    const headers = await asAdmin(app)
    reports.recordCrash({ kind: 'unclean-exit', summary: 'closed' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/reports/decide',
      headers,
      payload: { send: true, always: true },
    })
    expect(res.statusCode).toBe(200)
    expect(store.getSetting(AUTO_SEND_KEY)).toBe('1')
    const flushed = await app.inject({ method: 'POST', url: '/api/admin/reports/send', headers })
    expect(flushed.json()).toMatchObject({ result: { sent: 1 } })
    expect(sent).toHaveLength(1)
  })

  it('deletes on Don’t send', async () => {
    const { app, reports, sent } = newApp()
    reports.recordCrash({ kind: 'unclean-exit', summary: 'closed' })
    await app.inject({
      method: 'POST',
      url: '/api/admin/reports/decide',
      headers: await asAdmin(app),
      payload: { send: false },
    })
    await reports.flush()
    expect(sent).toEqual([])
    expect(reports.queue.list()).toEqual([])
  })

  it('flips the setting', async () => {
    const { app, store } = newApp()
    const headers = await asAdmin(app)
    const on = await app.inject({
      method: 'PATCH',
      url: '/api/admin/reports',
      headers,
      payload: { autoSend: true },
    })
    expect(on.json()).toMatchObject({ reports: { autoSend: true } })
    expect(store.getSetting(AUTO_SEND_KEY)).toBe('1')
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/reports',
      headers,
      payload: { autoSend: false },
    })
    expect(store.getSetting(AUTO_SEND_KEY)).toBe('0')
  })
})
