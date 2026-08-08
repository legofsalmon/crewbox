import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { Collector } from '../src/audit/collector.ts'
import { BUCKET_MS, MetricsStore } from '../src/audit/metrics.ts'
import type { DmxOutage, UniverseHealth } from '../src/dmx/state.ts'
import type { ClockStatus } from '../src/netwatch/ptp.ts'

/**
 * The collector is driven entirely by an injected clock and fake sources —
 * no timers, no sockets. What matters: samples roll up on the minute
 * boundary, and every state *transition* becomes exactly one event (a
 * conflict that persists for ten samples is one story, not ten).
 */

const universe = (over: Partial<UniverseHealth> = {}): UniverseHealth => ({
  universe: 1,
  wireUniverse: 1,
  protocol: 'sacn',
  sources: [
    {
      id: 'src-a',
      name: 'grandMA3',
      protocol: 'sacn',
      priority: 100,
      lastSeen: 0,
      rateHz: 44,
      lossPct: 0.5,
    },
  ],
  winnerId: 'src-a',
  conflict: false,
  sync: 'none',
  syncAddress: 0,
  lastSeen: 0,
  since: 0,
  ...over,
})

const clock = (over: Partial<ClockStatus> = {}): ClockStatus => ({
  grandmasterId: 'aa:bb',
  domain: 0,
  priority1: 128,
  clockClass: 248,
  since: 0,
  lastAnnounce: 0,
  changes: [],
  announcers: 1,
  v1RateHz: 0,
  v1Seen: false,
  ...over,
})

function harness(sources: Partial<ConstructorParameters<typeof Collector>[1]> = {}) {
  const metrics = new MetricsStore(openDb(':memory:'))
  let now = BUCKET_MS // start exactly on a minute boundary
  const collector = new Collector(
    metrics,
    { hubStats: () => ({ connections: 3, onlineUsers: 2 }), ...sources },
    { now: () => now }
  )
  return {
    metrics,
    collector,
    tick(ms = 5_000) {
      now += ms
      collector.sample()
    },
    setNow(ts: number) {
      now = ts
    },
  }
}

describe('rollups', () => {
  it('flushes a bucket when the minute rolls over', () => {
    const h = harness()
    h.tick(5_000)
    h.tick(5_000)
    // Still inside the first minute: nothing written yet.
    expect(h.metrics.series('crew.connections', '', 0, 10 * BUCKET_MS)).toHaveLength(0)
    h.tick(BUCKET_MS)
    const series = h.metrics.series('crew.connections', '', 0, 10 * BUCKET_MS)
    expect(series).toHaveLength(1)
    expect(series[0]).toMatchObject({ min: 3, avg: 3, max: 3, count: 2 })
  })

  it('records winner rate and loss per universe, skipping null loss', () => {
    let loss: number | null = 2
    const h = harness({
      dmxHealth: () => [universe({ sources: [{ ...universe().sources[0]!, lossPct: loss }] })],
    })
    h.tick(5_000)
    loss = null // Art-Net sequencing off — "cannot say" must not become 0%
    h.tick(5_000)
    h.tick(BUCKET_MS)
    const lossSeries = h.metrics.series('dmx.lossPct', '1', 0, 10 * BUCKET_MS)
    expect(lossSeries[0]!.count).toBe(1)
    const rateSeries = h.metrics.series('dmx.rateHz', '1', 0, 10 * BUCKET_MS)
    expect(rateSeries[0]!.count).toBe(2)
  })

  it('turns monotonic watcher counters into per-minute deltas', () => {
    let packets = 100
    const h = harness({
      netwatchStatus: () => ({
        ptp: { listening: true, error: null, packets },
        mdns: { listening: true, error: null, packets: 0 },
        sap: { listening: true, error: null, packets: 0 },
        interfaceIp: null,
      }),
    })
    h.tick(5_000) // first sight: no previous, no delta
    packets = 130
    h.tick(5_000) // delta 30
    packets = 150
    h.tick(5_000) // delta 20
    h.tick(BUCKET_MS)
    const series = h.metrics.series('watch.packets', 'ptp', 0, 10 * BUCKET_MS)
    expect(series[0]).toMatchObject({ count: 2, min: 20, max: 30 })
  })

  it('stop() flushes the partial bucket so shutdown loses nothing', () => {
    const h = harness()
    h.tick(5_000)
    h.collector.stop()
    expect(h.metrics.series('crew.connections', '', 0, 10 * BUCKET_MS)).toHaveLength(1)
  })
})

describe('events', () => {
  it('emits one event per conflict transition, not per sample', () => {
    let conflict = false
    const h = harness({ dmxHealth: () => [universe({ conflict })] })
    h.tick()
    conflict = true
    h.tick()
    h.tick()
    h.tick()
    conflict = false
    h.tick()
    const kinds = h.metrics.events(0).map((e) => e.kind)
    expect(kinds.filter((k) => k === 'dmx.conflict.start')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'dmx.conflict.end')).toHaveLength(1)
  })

  it('emits frozen/recovered transitions', () => {
    let sync: UniverseHealth['sync'] = 'held'
    const h = harness({ dmxHealth: () => [universe({ sync })] })
    h.tick()
    sync = 'frozen'
    h.tick()
    sync = 'none'
    h.tick()
    const kinds = h.metrics.events(0).map((e) => e.kind)
    expect(kinds).toContain('dmx.sync.frozen')
    expect(kinds).toContain('dmx.sync.recovered')
  })

  it('emits a grandmaster change once, including going silent', () => {
    let gm: string | null = 'aa:bb'
    const h = harness({ ptpStatus: () => clock({ grandmasterId: gm }) })
    h.tick()
    h.tick()
    gm = 'cc:dd'
    h.tick()
    gm = null
    h.tick()
    const changes = h.metrics.events(0).filter((e) => e.kind === 'ptp.gm.change')
    expect(changes).toHaveLength(2)
    expect(changes.some((e) => e.detail.includes('went silent'))).toBe(true)
  })

  it('emits each outage once, keyed by its start time', () => {
    const outages: DmxOutage[] = []
    const h = harness({ dmxOutages: () => outages })
    h.tick()
    outages.push({ protocol: 'sacn', at: 12345, universes: [1, 2], otherProtocolAlive: false })
    h.tick()
    h.tick()
    const events = h.metrics.events(0).filter((e) => e.kind === 'dmx.outage')
    expect(events).toHaveLength(1)
    expect(events[0]!.detail).toContain('2 universes')
  })

  it('emits device appear and goodbye from the mDNS roster', () => {
    const roster: import('../src/netwatch/mdns.ts').MediaService[] = []
    const h = harness({ mdnsRoster: () => roster })
    h.tick()
    roster.push({
      name: 'StageBox',
      kind: 'dante',
      address: '',
      firstSeen: 0,
      lastSeen: 0,
      saidGoodbye: false,
    })
    h.tick()
    roster[0]!.saidGoodbye = true
    h.tick()
    const kinds = h.metrics.events(0).map((e) => e.kind)
    expect(kinds).toContain('media.device.appear')
    expect(kinds).toContain('media.device.gone')
  })

  it('works without a metrics store (nothing written, nothing thrown)', () => {
    const collector = new Collector(
      undefined,
      { hubStats: () => ({ connections: 1, onlineUsers: 1 }) },
      { now: () => BUCKET_MS }
    )
    collector.sample()
    collector.stop()
  })
})
