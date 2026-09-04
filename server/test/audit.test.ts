import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { MetricsStore } from '../src/audit/metrics.ts'
import { buildApp, type App } from '../src/app.ts'

/**
 * The audit endpoints belong to the whole crew — session-authed, never
 * admin-gated — and their query surface is clamped so no request can drag
 * the whole metrics table through JSON.
 */

const EVENT_PIN = '4242'
const ADMIN_PASSWORD = 'audit-admin-pass'
let app: App
let metrics: MetricsStore
let filesDir: string

async function join_(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, eventPin: EVENT_PIN, personalPin: '1234' },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { token: string }).token
}

beforeEach(async () => {
  filesDir = mkdtempSync(join(tmpdir(), 'crewbox-audit-'))
  const db = openDb(':memory:')
  const store = new Store(db)
  store.createChannel('general', 'public', 'Everyone')
  metrics = new MetricsStore(db)
  app = buildApp({
    store,
    eventPin: EVENT_PIN,
    filesDir,
    dataDir: filesDir,
    metrics,
    adminPassword: ADMIN_PASSWORD,
    modules: ['chat', 'network'],
    logger: false,
  })
})

afterEach(async () => {
  await app.close()
  rmSync(filesDir, { recursive: true, force: true })
})

describe('/api/audit', () => {
  it('refuses without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit' })
    expect(res.statusCode).toBe(401)
  })

  it('returns a graded report to any crew member', async () => {
    const token = await join_('Alex')
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      report: { networks: Array<{ id: string; grade: string }> }
      probeRunning: boolean
    }
    expect(body.report.networks.map((n) => n.id)).toEqual(['crew', 'lighting', 'media'])
    // This box watches nothing, and the report says so honestly.
    expect(body.report.networks[1]!.grade).toBe('unknown')
    expect(body.probeRunning).toBe(false)
  })

  it('carries recent events into the payload', async () => {
    metrics.recordEvent({
      at: Date.now() - 60_000,
      network: 'lighting',
      kind: 'dmx.outage',
      key: 'sacn',
      detail: '3 universes went dark together',
    })
    const token = await join_('Sam')
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = res.json() as { events: Array<{ kind: string }> }
    expect(body.events.some((e) => e.kind === 'dmx.outage')).toBe(true)
  })
})

describe('/api/audit/series', () => {
  it('validates the metric against the catalogue', async () => {
    const token = await join_('Kit')
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/series?metric=sqlite_master&key=&from=0&to=1000',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns points and clamps the span to a day', async () => {
    const now = Date.now()
    metrics.flush([
      // Two days ago — must be clamped out of a to=now request.
      {
        ts: now - 2 * 24 * 60 * 60_000,
        metric: 'crew.connections',
        key: '',
        min: 1,
        avg: 1,
        max: 1,
        count: 1,
      },
      { ts: now - 60_000, metric: 'crew.connections', key: '', min: 5, avg: 6, max: 7, count: 12 },
    ])
    const token = await join_('Ash')
    const res = await app.inject({
      method: 'GET',
      url: `/api/audit/series?metric=crew.connections&key=&from=0&to=${now}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { points: number[][] }
    expect(body.points).toHaveLength(1)
    expect(body.points[0]).toEqual([now - 60_000, 5, 6, 7, 12])
  })
})

describe('/api/audit/bundle', () => {
  const asAdmin = async (name: string) => {
    const token = await join_(name)
    const unlock = await app.inject({
      method: 'POST',
      url: '/api/admin/unlock',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: ADMIN_PASSWORD },
    })
    expect(unlock.statusCode).toBe(200)
    const { adminToken } = unlock.json() as { adminToken: string }
    return { authorization: `Bearer ${token}`, 'x-admin-token': adminToken }
  }

  it('needs an admin and returns every series in the span', async () => {
    const now = Date.now()
    metrics.flush([
      { ts: now - 60_000, metric: 'crew.connections', key: '', min: 1, avg: 1, max: 1, count: 1 },
      { ts: now - 60_000, metric: 'dmx.rateHz', key: '1', min: 40, avg: 44, max: 44, count: 12 },
    ])
    expect(
      (await app.inject({ method: 'GET', url: `/api/audit/bundle?from=0&to=${now}` })).statusCode
    ).toBe(401)
    // A plain crew session is not enough any more: this route can build a
    // festival's week into one response on the loop the show runs on.
    const crew = await join_('Bo')
    const denied = await app.inject({
      method: 'GET',
      url: `/api/audit/bundle?from=0&to=${now}`,
      headers: { authorization: `Bearer ${crew}` },
    })
    expect([401, 403]).toContain(denied.statusCode)

    const res = await app.inject({
      method: 'GET',
      url: `/api/audit/bundle?from=0&to=${now}`,
      headers: await asAdmin('Boss1'),
    })
    const body = res.json() as { rows: Array<{ metric: string }> }
    expect(body.rows.map((r) => r.metric).sort()).toEqual(['crew.connections', 'dmx.rateHz'])
  })

  it('pages rather than serialising a festival in one go', async () => {
    const now = Date.now()
    metrics.flush(
      Array.from({ length: 12 }, (_, i) => ({
        ts: now - (12 - i) * 60_000,
        metric: 'crew.connections',
        key: '',
        min: i,
        avg: i,
        max: i,
        count: 1,
      }))
    )
    const headers = await asAdmin('Boss2')
    const first = await app.inject({
      method: 'GET',
      url: `/api/audit/bundle?from=0&to=${now}&limit=5`,
      headers,
    })
    const page1 = first.json() as {
      rows: Array<{ ts: number }>
      next?: { metric: string; key: string; ts: number }
    }
    expect(page1.rows).toHaveLength(5)
    expect(page1.next).toBeTruthy()

    const second = await app.inject({
      method: 'GET',
      url:
        `/api/audit/bundle?from=0&to=${now}&limit=5&afterMetric=${page1.next!.metric}` +
        `&afterKey=${page1.next!.key}&afterTs=${page1.next!.ts}`,
      headers,
    })
    const page2 = second.json() as { rows: Array<{ ts: number }> }
    expect(page2.rows).toHaveLength(5)
    // Continues rather than repeating: no row appears in both pages.
    const seen = new Set(page1.rows.map((r) => r.ts))
    expect(page2.rows.every((r) => !seen.has(r.ts))).toBe(true)
  })
})

describe('POST /api/audit/probe', () => {
  it('is admin-gated: a plain crew session cannot start a sweep', async () => {
    const token = await join_('Crewbie')
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit/probe',
      headers: { authorization: `Bearer ${token}` },
    })
    expect([401, 403]).toContain(res.statusCode)
  })

  it('starts for an unlocked admin and reports running via GET', async () => {
    const token = await join_('Boss')
    const unlock = await app.inject({
      method: 'POST',
      url: '/api/admin/unlock',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: ADMIN_PASSWORD },
    })
    expect(unlock.statusCode).toBe(200)
    const { adminToken } = unlock.json() as { adminToken: string }
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit/probe',
      headers: { authorization: `Bearer ${token}`, 'x-admin-token': adminToken },
    })
    expect(res.statusCode).toBe(202)
    // The sweep runs with real (failing, sandboxed) probes; what matters
    // here is that it eventually lands as a finished run in the payload.
    for (let i = 0; i < 100; i++) {
      const audit = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { authorization: `Bearer ${token}` },
      })
      const body = audit.json() as { probe: { finishedAt: number | null } | null }
      if (body.probe?.finishedAt) {
        return // finished — probes fail-soft into info/skipped states
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('probe run never finished')
  }, 20_000)
})

describe('module gating', () => {
  it('the routes do not exist when the network module is off', async () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    store.createChannel('general', 'public', 'Everyone')
    const bare = buildApp({
      store,
      eventPin: EVENT_PIN,
      dataDir: filesDir,
      modules: ['chat'],
      logger: false,
    })
    const res = await bare.inject({ method: 'GET', url: '/api/audit' })
    expect(res.statusCode).toBe(404)
    await bare.close()
  })
})
