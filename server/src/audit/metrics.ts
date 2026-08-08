import type { DatabaseSync } from 'node:sqlite'
import { newId } from '@crewbox/shared'
import { transaction } from '../db.ts'

/**
 * The network audit's memory: minute-resolution rollups, discrete events and
 * probe runs, in the box's own SQLite so a five-day festival's picture
 * survives restarts and power cuts.
 *
 * This is the deliberate exception to "kept in memory and never written
 * down" (dmx/state.ts): the audit's whole value is history — "it was fine
 * until 17:40" — and history that dies with the process answers nothing.
 * The state classes stay I/O-free; all persistence lives here, in a caller.
 *
 * Bounds are structural, not hopeful: minute buckets (one small transaction
 * a minute), a key cap per metric so a hostile sender naming thousands of
 * universes cannot mint series, an event throttle so a flapping network
 * cannot fill the disk, and a rolling prune. Worst realistic case is a few
 * hundred thousand rows over a week — tens of megabytes.
 *
 * Clock steps (an NTP jump mid-event) can write buckets out of order.
 * Range queries and the prune tolerate that; charts may show a seam, which
 * is honest — the box's clock really did move.
 */

/** Rollup bucket width. The audit answers in minutes, not milliseconds. */
export const BUCKET_MS = 60_000

/** How long history is kept. Longer than any festival, shorter than forever. */
export const RETENTION_MS = 7 * 24 * 60 * 60_000

/** Most distinct keys one metric may grow (e.g. universes). */
export const MAX_KEYS_PER_METRIC = 64

/** Most events recorded per hour before throttling kicks in. */
export const MAX_EVENTS_PER_HOUR = 500

/**
 * Every metric the collector writes. The series endpoint validates against
 * this list, so a request can't turn arbitrary strings into table scans.
 */
export const AUDIT_METRICS = [
  'crew.connections',
  'crew.onlineUsers',
  'crew.rtt',
  'dmx.rateHz',
  'dmx.lossPct',
  'dmx.sources',
  'media.ptpAnnouncers',
  'media.ptpV1RateHz',
  'media.mdnsDevices',
  'media.sapStreams',
  'watch.packets',
] as const

export interface RollupRow {
  ts: number
  metric: string
  key: string
  min: number
  avg: number
  max: number
  count: number
}

export interface AuditEvent {
  id: string
  at: number
  network: 'crew' | 'lighting' | 'media'
  kind: string
  key: string
  detail: string
}

export interface ProbeRunRecord {
  id: string
  startedAt: number
  finishedAt: number | null
  by: string
  /** JSON-serialisable probe report; shape owned by audit/probes.ts. */
  report: unknown
}

/** In-memory accumulator for one series within the current bucket. */
export interface Accumulator {
  min: number
  max: number
  sum: number
  count: number
}

/** Fold one sample into an accumulator (creating it on first sight). */
export function accumulate(acc: Accumulator | undefined, value: number): Accumulator {
  if (!acc) return { min: value, max: value, sum: value, count: 1 }
  acc.min = Math.min(acc.min, value)
  acc.max = Math.max(acc.max, value)
  acc.sum += value
  acc.count += 1
  return acc
}

/** The minute bucket a timestamp belongs to. */
export function bucketOf(ts: number): number {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS
}

interface MetricRow {
  ts: number
  metric: string
  key: string
  min: number
  avg: number
  max: number
  count: number
}

interface EventRow {
  id: string
  at: number
  network: string
  kind: string
  key: string
  detail: string
}

interface ProbeRow {
  id: string
  started_at: number
  finished_at: number | null
  by_name: string
  report: string
}

export class MetricsStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Write one bucket's rollups atomically. Idempotent per (metric,key,ts). */
  flush(rows: RollupRow[]): void {
    if (rows.length === 0) return
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO audit_metrics (ts, metric, key, min, avg, max, count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    transaction(this.db, () => {
      for (const row of rows) {
        insert.run(row.ts, row.metric, row.key, row.min, row.avg, row.max, row.count)
      }
    })
  }

  /** One series, oldest first, clamped to [from, to]. */
  series(metric: string, key: string, from: number, to: number): RollupRow[] {
    return this.db
      .prepare(
        `SELECT ts, metric, key, min, avg, max, count FROM audit_metrics
         WHERE metric = ? AND key = ? AND ts >= ? AND ts <= ?
         ORDER BY ts ASC`
      )
      .all(metric, key, from, to) as unknown as MetricRow[]
  }

  /** Every series in one span — the export's single fetch. */
  bundle(from: number, to: number): RollupRow[] {
    return this.db
      .prepare(
        `SELECT ts, metric, key, min, avg, max, count FROM audit_metrics
         WHERE ts >= ? AND ts <= ?
         ORDER BY metric ASC, key ASC, ts ASC`
      )
      .all(from, to) as unknown as MetricRow[]
  }

  recordEvent(event: Omit<AuditEvent, 'id'>): AuditEvent {
    const row: AuditEvent = { id: newId(), ...event }
    this.db
      .prepare(
        `INSERT INTO audit_events (id, at, network, kind, key, detail)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.at, row.network, row.kind, row.key, row.detail)
    return row
  }

  /** Events since `from`, newest first, bounded. */
  events(from: number, limit = 200): AuditEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, at, network, kind, key, detail FROM audit_events
         WHERE at >= ? ORDER BY at DESC LIMIT ?`
      )
      .all(from, limit) as unknown as EventRow[]
    return rows.map((r) => ({ ...r, network: r.network as AuditEvent['network'] }))
  }

  /** Events recorded in the last hour — the throttle's own bookkeeping. */
  countEventsSince(from: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE at >= ?`)
      .get(from) as unknown as { n: number }
    return row.n
  }

  saveProbeRun(run: ProbeRunRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO audit_probe_runs (id, started_at, finished_at, by_name, report)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(run.id, run.startedAt, run.finishedAt, run.by, JSON.stringify(run.report ?? {}))
  }

  latestProbeRun(): ProbeRunRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, started_at, finished_at, by_name, report FROM audit_probe_runs
         ORDER BY started_at DESC LIMIT 1`
      )
      .get() as unknown as ProbeRow | undefined
    if (!row) return null
    let report: unknown = {}
    try {
      report = JSON.parse(row.report)
    } catch {
      // A corrupt row loses its detail, not the audit.
    }
    return {
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      by: row.by_name,
      report,
    }
  }

  /** Drop everything older than `before` (rollups, events, probe runs). */
  prune(before: number): void {
    transaction(this.db, () => {
      this.db.prepare(`DELETE FROM audit_metrics WHERE ts < ?`).run(before)
      this.db.prepare(`DELETE FROM audit_events WHERE at < ?`).run(before)
      this.db.prepare(`DELETE FROM audit_probe_runs WHERE started_at < ?`).run(before)
    })
  }
}
