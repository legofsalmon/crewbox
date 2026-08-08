import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import {
  accumulate,
  bucketOf,
  BUCKET_MS,
  MetricsStore,
  type Accumulator,
} from '../src/audit/metrics.ts'

/**
 * The audit's memory. What matters here: rollup arithmetic is exact, writes
 * are idempotent per bucket, ranges come back in order, and the prune drops
 * everything old in one pass — this store is the only thing standing between
 * a five-day festival and an unbounded database.
 */
describe('rollup arithmetic', () => {
  it('folds samples into min/avg/max/count', () => {
    let acc: Accumulator | undefined
    for (const v of [10, 2, 6]) acc = accumulate(acc, v)
    expect(acc).toEqual({ min: 2, max: 10, sum: 18, count: 3 })
  })

  it('starts an accumulator from its first sample', () => {
    expect(accumulate(undefined, 44)).toEqual({ min: 44, max: 44, sum: 44, count: 1 })
  })

  it('buckets timestamps to the minute', () => {
    expect(bucketOf(0)).toBe(0)
    expect(bucketOf(BUCKET_MS - 1)).toBe(0)
    expect(bucketOf(BUCKET_MS)).toBe(BUCKET_MS)
    expect(bucketOf(BUCKET_MS * 3 + 123)).toBe(BUCKET_MS * 3)
  })
})

describe('MetricsStore', () => {
  const open = () => new MetricsStore(openDb(':memory:'))

  const row = (over: Record<string, unknown> = {}) => ({
    ts: 60_000,
    metric: 'dmx.lossPct',
    key: '1',
    min: 0,
    avg: 1.5,
    max: 3,
    count: 12,
    ...over,
  })

  it('round-trips a series in time order', () => {
    const store = open()
    store.flush([row({ ts: 120_000, avg: 2 }), row({ ts: 60_000, avg: 1 })])
    const series = store.series('dmx.lossPct', '1', 0, 200_000)
    expect(series.map((r) => [r.ts, r.avg])).toEqual([
      [60_000, 1],
      [120_000, 2],
    ])
  })

  it('re-flushing a bucket replaces it rather than duplicating', () => {
    const store = open()
    store.flush([row({ avg: 1 })])
    store.flush([row({ avg: 9 })])
    const series = store.series('dmx.lossPct', '1', 0, 200_000)
    expect(series).toHaveLength(1)
    expect(series[0]!.avg).toBe(9)
  })

  it('clamps a series to the requested span', () => {
    const store = open()
    store.flush([row({ ts: 60_000 }), row({ ts: 120_000 }), row({ ts: 180_000 })])
    expect(store.series('dmx.lossPct', '1', 120_000, 120_000)).toHaveLength(1)
  })

  it('bundle returns every series, grouped', () => {
    const store = open()
    store.flush([
      row({ metric: 'dmx.rateHz', key: '1', ts: 60_000 }),
      row({ metric: 'crew.connections', key: '', ts: 60_000 }),
    ])
    const all = store.bundle(0, 200_000)
    expect(all.map((r) => r.metric).sort()).toEqual(['crew.connections', 'dmx.rateHz'])
  })

  it('records and lists events newest first, bounded', () => {
    const store = open()
    for (let i = 0; i < 5; i++) {
      store.recordEvent({
        at: i * 1000,
        network: 'lighting',
        kind: 'dmx.outage',
        key: 'sacn',
        detail: `outage ${i}`,
      })
    }
    const events = store.events(0, 3)
    expect(events).toHaveLength(3)
    expect(events[0]!.detail).toBe('outage 4')
    expect(store.countEventsSince(3000)).toBe(2)
  })

  it('persists and returns the latest probe run, surviving bad JSON', () => {
    const store = open()
    store.saveProbeRun({
      id: 'run-1',
      startedAt: 1000,
      finishedAt: 2000,
      by: 'Colm',
      report: { probes: [] },
    })
    store.saveProbeRun({ id: 'run-2', startedAt: 5000, finishedAt: null, by: 'Colm', report: {} })
    const latest = store.latestProbeRun()
    expect(latest?.id).toBe('run-2')
    expect(latest?.finishedAt).toBeNull()
  })

  it('prune drops old rollups, events and probe runs together', () => {
    const store = open()
    store.flush([row({ ts: 60_000 }), row({ ts: 600_000 })])
    store.recordEvent({ at: 60_000, network: 'crew', kind: 'x', key: '', detail: '' })
    store.recordEvent({ at: 600_000, network: 'crew', kind: 'x', key: '', detail: '' })
    store.saveProbeRun({ id: 'old', startedAt: 60_000, finishedAt: 61_000, by: 'a', report: {} })
    store.prune(500_000)
    expect(store.series('dmx.lossPct', '1', 0, 10_000_000)).toHaveLength(1)
    expect(store.events(0)).toHaveLength(1)
    expect(store.latestProbeRun()).toBeNull()
  })
})
