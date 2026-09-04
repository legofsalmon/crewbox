import { describe, expect, it } from 'vitest'
import {
  cyclicOutages,
  scoreAudit,
  worstFinding,
  type AuditFinding,
  type ScoreInput,
} from '../src/audit/score.ts'
import type { UniverseHealth } from '../src/dmx/state.ts'
import type { ClockStatus } from '../src/netwatch/ptp.ts'
import type { AuditEvent, RollupRow } from '../src/audit/metrics.ts'

/**
 * The scorer is pure, so every grade is a table test. Each threshold is
 * probed from both sides — the finding must appear exactly when the number
 * crosses the line, and the copy must carry the number it judged.
 */

const NOW = 1_700_000_000_000

const universe = (over: Partial<UniverseHealth> = {}): UniverseHealth => ({
  universe: 1,
  wireUniverse: 1,
  protocol: 'sacn',
  sources: [
    {
      id: 'a',
      name: 'desk',
      protocol: 'sacn',
      priority: 100,
      lastSeen: NOW,
      rateHz: 44,
      lossPct: 0,
    },
  ],
  winnerId: 'a',
  conflict: false,
  sync: 'none',
  syncAddress: 0,
  lastSeen: NOW,
  since: NOW - 60_000,
  ...over,
})

const ptp = (over: Partial<ClockStatus> = {}): ClockStatus => ({
  grandmasterId: '00:1d:c1:ff:fe:00:00:01',
  domain: 0,
  domains: 1,
  priority1: 128,
  clockClass: 248,
  since: NOW - 3_600_000,
  lastAnnounce: NOW,
  changes: [],
  announcers: 1,
  v1RateHz: 0,
  v1Seen: false,
  ...over,
})

const rollup = (metric: string, key: string, avg: number, max = avg): RollupRow => ({
  ts: NOW - 60_000,
  metric,
  key,
  min: avg,
  avg,
  max,
  count: 10,
})

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    now: NOW,
    configured: { dmx: false, watch: false },
    hub: { connections: 4, onlineUsers: 3 },
    recentSeries: () => [],
    events: [],
    probe: null,
    ...over,
  }
}

const network = (report: ReturnType<typeof scoreAudit>, id: string) =>
  report.networks.find((n) => n.id === id)!

const finding = (report: ReturnType<typeof scoreAudit>, netId: string, findingId: string) =>
  network(report, netId).findings.find((f) => f.id === findingId)

describe('grading', () => {
  it('info findings never colour a grade', () => {
    const findings: AuditFinding[] = [
      { id: 'a', label: '', state: 'ok', detail: '' },
      { id: 'b', label: '', state: 'info', detail: '' },
    ]
    expect(worstFinding(findings)).toBe('ok')
  })

  it('off outranks limited', () => {
    const findings: AuditFinding[] = [
      { id: 'a', label: '', state: 'limited', detail: '' },
      { id: 'b', label: '', state: 'off', detail: '' },
    ]
    expect(worstFinding(findings)).toBe('off')
  })

  it('unwatched networks grade unknown, with the fix attached', () => {
    const report = scoreAudit(input())
    expect(network(report, 'lighting').grade).toBe('unknown')
    expect(network(report, 'media').grade).toBe('unknown')
    expect(finding(report, 'lighting', 'light-listening')?.fix).toContain('lighting-network')
  })
})

describe('crew', () => {
  it('reports device counts as information', () => {
    const report = scoreAudit(input())
    const f = finding(report, 'crew', 'crew-clients')
    expect(f?.state).toBe('info')
    expect(f?.detail).toContain('4 connections')
  })

  it.each([
    [100, 'ok'],
    [150, 'ok'],
    [151, 'limited'],
    [400, 'limited'],
    [401, 'off'],
  ])('grades %i ms crowd RTT as %s', (ms, expected) => {
    const report = scoreAudit(
      input({ recentSeries: (m) => (m === 'crew.rtt' ? [rollup('crew.rtt', '', ms)] : []) })
    )
    expect(finding(report, 'crew', 'crew-rtt')?.state).toBe(expected)
  })

  it('says nothing about RTT with no data', () => {
    expect(finding(scoreAudit(input()), 'crew', 'crew-rtt')).toBeUndefined()
  })
})

describe('lighting', () => {
  const lit = (over: Partial<ScoreInput> = {}) =>
    input({
      configured: { dmx: true, watch: false },
      dmx: { health: [universe()], outages: [], discovered: [], nodes: [] },
      ...over,
    })

  it('listening with data is ok', () => {
    const report = scoreAudit(lit())
    expect(network(report, 'lighting').grade).toBe('ok')
    expect(finding(report, 'lighting', 'light-arriving')?.state).toBe('ok')
  })

  it('listening but silent is limited', () => {
    const report = scoreAudit(lit({ dmx: { health: [], outages: [], discovered: [], nodes: [] } }))
    expect(finding(report, 'lighting', 'light-arriving')?.state).toBe('limited')
  })

  it.each([
    [0.9, undefined],
    [1.0, 'limited'],
    [4.9, 'limited'],
    [5.0, 'off'],
  ])('grades %f%% sustained loss as %s', (pct, expected) => {
    const report = scoreAudit(
      lit({
        recentSeries: (m, k) =>
          m === 'dmx.lossPct' && k === '1' ? [rollup('dmx.lossPct', '1', pct)] : [],
      })
    )
    const f = finding(report, 'lighting', 'light-loss-1')
    if (expected === undefined) expect(f).toBeUndefined()
    else {
      expect(f?.state).toBe(expected)
      expect(f?.detail).toContain(`${pct.toFixed(1)}%`)
      expect(f?.series).toEqual({ metric: 'dmx.lossPct', key: '1' })
    }
  })

  it('flags a sagging refresh rate only when it has been faster', () => {
    const sagging = scoreAudit(
      lit({
        recentSeries: (m) => (m === 'dmx.rateHz' ? [rollup('dmx.rateHz', '1', 10, 40)] : []),
      })
    )
    expect(finding(sagging, 'lighting', 'light-rate-1')?.state).toBe('limited')
    // A rig genuinely running slow (never fast) is not "sagging".
    const slow = scoreAudit(
      lit({
        recentSeries: (m) => (m === 'dmx.rateHz' ? [rollup('dmx.rateHz', '1', 10, 12)] : []),
      })
    )
    expect(finding(slow, 'lighting', 'light-rate-1')).toBeUndefined()
  })

  it('a live conflict is limited; a resolved one is information with the time', () => {
    const live = scoreAudit(
      lit({
        dmx: { health: [universe({ conflict: true })], outages: [], discovered: [], nodes: [] },
      })
    )
    expect(finding(live, 'lighting', 'light-conflict')?.state).toBe('limited')

    const resolved = scoreAudit(
      lit({
        events: [
          {
            id: 'e1',
            at: NOW - 20 * 60_000,
            network: 'lighting',
            kind: 'dmx.conflict.start',
            key: '1',
            detail: '',
          },
        ],
      })
    )
    const f = finding(resolved, 'lighting', 'light-conflict')
    expect(f?.state).toBe('info')
    expect(f?.detail).toContain('Resolved now')
  })

  it('a frozen stage is an off-grade fault', () => {
    const report = scoreAudit(
      lit({
        dmx: { health: [universe({ sync: 'frozen' })], outages: [], discovered: [], nodes: [] },
      })
    )
    expect(finding(report, 'lighting', 'light-sync')?.state).toBe('off')
    expect(network(report, 'lighting').grade).toBe('off')
  })

  it('names the missing-querier cycle from rhythmic outages', () => {
    const events: AuditEvent[] = [0, 5, 10, 15].map((min, i) => ({
      id: `e${i}`,
      at: NOW - (20 - min) * 60_000,
      network: 'lighting',
      kind: 'dmx.outage',
      key: 'sacn',
      detail: '',
    }))
    const report = scoreAudit(lit({ events }))
    const f = finding(report, 'lighting', 'light-cycle')
    expect(f?.state).toBe('limited')
    expect(f?.fix).toContain('IGMP querier')
  })

  it('does not cry querier over irregular outages', () => {
    const events: AuditEvent[] = [0, 1, 30].map((min, i) => ({
      id: `e${i}`,
      at: NOW - (40 - min) * 60_000,
      network: 'lighting',
      kind: 'dmx.outage',
      key: 'sacn',
      detail: '',
    }))
    expect(finding(scoreAudit(lit({ events })), 'lighting', 'light-cycle')).toBeUndefined()
  })
})

describe('media', () => {
  const watched = (over: Partial<ScoreInput> = {}) =>
    input({
      configured: { dmx: false, watch: true },
      watch: {
        ptp: { listening: true, error: null, packets: 10 },
        mdns: { listening: true, error: null, packets: 10 },
        sap: { listening: true, error: null, packets: 0 },
        interfaceIp: null,
      },
      ptp: ptp(),
      mdns: [],
      sap: [],
      ...over,
    })

  it('a steady clock is ok, with its identity in the copy', () => {
    const report = scoreAudit(watched())
    const f = finding(report, 'media', 'media-clock')
    expect(f?.state).toBe('ok')
    expect(f?.detail).toContain('00:1d:c1')
  })

  it.each([
    [0, 'ok'],
    [1, 'limited'],
    [2, 'limited'],
    [3, 'off'],
  ])('grades %i grandmaster changes as %s', (n, expected) => {
    const changes = Array.from({ length: n }, (_, i) => ({
      at: NOW - i * 60_000,
      from: 'x',
      to: 'y',
    }))
    const report = scoreAudit(watched({ ptp: ptp({ changes }) }))
    expect(finding(report, 'media', 'media-clock')?.state).toBe(expected)
  })

  it('v1-only clocking is ok; mixed generations is information', () => {
    const v1only = scoreAudit(
      watched({ ptp: ptp({ grandmasterId: null, v1Seen: true, v1RateHz: 8 }) })
    )
    expect(finding(v1only, 'media', 'media-clock')?.state).toBe('ok')

    const mixed = scoreAudit(watched({ ptp: ptp({ v1Seen: true, v1RateHz: 8 }) }))
    expect(finding(mixed, 'media', 'media-mixed-ptp')?.state).toBe('info')
  })

  it('no clock at all on a watched network is limited', () => {
    const report = scoreAudit(watched({ ptp: ptp({ grandmasterId: null, v1Seen: false }) }))
    expect(finding(report, 'media', 'media-clock')?.state).toBe('limited')
  })

  it('devices leaving in the last hour is limited, with the last time', () => {
    const report = scoreAudit(
      watched({
        events: [
          {
            id: 'e1',
            at: NOW - 10 * 60_000,
            network: 'media',
            kind: 'media.device.gone',
            key: 'dante:StageBox',
            detail: '',
          },
        ],
      })
    )
    const f = finding(report, 'media', 'media-churn')
    expect(f?.state).toBe('limited')
    expect(f?.fix).toContain('PoE')
  })
})

describe('cyclicOutages', () => {
  it('needs at least three events', () => {
    const events: AuditEvent[] = [0, 5].map((min, i) => ({
      id: `${i}`,
      at: min * 60_000,
      network: 'lighting',
      kind: 'dmx.outage',
      key: '',
      detail: '',
    }))
    expect(cyclicOutages(events, ['dmx.outage'])).toHaveLength(0)
  })
})
