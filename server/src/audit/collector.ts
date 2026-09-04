import type { DmxOutage, UniverseHealth } from '../dmx/state.ts'
import type { NetWatchStatus } from '../netwatch/listener.ts'
import type { ClockStatus } from '../netwatch/ptp.ts'
import type { MediaService } from '../netwatch/mdns.ts'
import type { SapStream } from '../netwatch/sap.ts'
import {
  accumulate,
  bucketOf,
  MAX_EVENTS_PER_HOUR,
  MAX_KEYS_PER_METRIC,
  RETENTION_MS,
  type Accumulator,
  type AuditEvent,
  type MetricsStore,
  type RollupRow,
} from './metrics.ts'

/**
 * The audit's eyes: samples the monitoring state the box already keeps —
 * DMX health, the PTP clock, the media rosters, who is connected — and
 * turns it into minute rollups and discrete events in the MetricsStore.
 *
 * Strictly a reader. Every source is an injected closure over state the
 * passive listeners maintain; the collector opens no sockets and sends
 * nothing, so the receive-only guarantee on the show networks is untouched
 * by construction. The state classes stay I/O-free (their own stated rule);
 * this caller is where their story gets written down.
 *
 * Events are found by diffing consecutive samples: a grandmaster change, an
 * outage appearing, a conflict starting or ending, a source or device
 * arriving or vanishing. The rollups say how the day went; the events say
 * when it changed — "it was fine until 17:40" needs both.
 */

/** How often the sources are read. Rollups stay minutes; this is sampling. */
export const SAMPLE_MS = 5_000

/** Sweep cadence for the retention prune. */
const PRUNE_EVERY_MS = 60 * 60_000

export interface CollectorSources {
  dmxHealth?: () => UniverseHealth[]
  dmxOutages?: () => DmxOutage[]
  ptpStatus?: (now: number) => ClockStatus
  netwatchStatus?: () => NetWatchStatus
  mdnsRoster?: () => MediaService[]
  sapRoster?: () => SapStream[]
  hubStats: () => { connections: number; onlineUsers: number }
}

export interface CollectorOptions {
  now?: () => number
  sampleMs?: number
  /**
   * Where to say that sampling has stopped working. Said once, not once a
   * minute — see `sample`.
   */
  log?: (message: string) => void
}

/** What the previous sample looked like, for edge detection. */
interface PreviousSample {
  grandmasterId: string | null
  outageAts: Set<number>
  conflicts: Set<number>
  frozen: Set<number>
  sourceIds: Map<number, Set<string>>
  mediaKeys: Set<string>
  goodbyes: Set<string>
  watcherErrors: Set<string>
  watchPackets: { ptp: number; mdns: number; sap: number } | null
}

export class Collector {
  private readonly now: () => number
  private readonly sampleMs: number
  private readonly log: (message: string) => void
  /** Whether the last pass failed, so the reason is logged once and not each minute. */
  private ailing = false
  private timer: NodeJS.Timeout | null = null
  private accumulators = new Map<string, Accumulator>()
  private bucketStart = 0
  private previous: PreviousSample | null = null
  private lastPrune = 0
  /** RTT samples reported by clients since the last flush (phase 6 hook). */
  private rttSamples: number[] = []
  private voiceSamples: Array<{ lossPct: number; jitterMs: number; concealedPct: number }> = []

  constructor(
    private readonly metrics: MetricsStore | undefined,
    private readonly sources: CollectorSources,
    options: CollectorOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.sampleMs = options.sampleMs ?? SAMPLE_MS
    this.log = options.log ?? ((message) => console.warn(message))
  }

  start(): void {
    if (this.timer) return
    this.bucketStart = bucketOf(this.now())
    this.timer = setInterval(() => this.sample(), this.sampleMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Flush the partial bucket so a clean shutdown loses nothing. `flush`
    // guards its own write, which matters more here than anywhere: this runs
    // on the way out, and a throw would take the database close and the SFU
    // stop with it.
    this.flush(this.bucketStart)
  }

  /** A client-reported WS round trip (crowd Wi-Fi quality, phase 6). */
  noteRtt(ms: number): void {
    this.rttSamples.push(ms)
  }

  /**
   * A device reporting how comms sounded to it.
   *
   * Kept per-sample rather than pre-averaged for the same reason as RTT: one
   * phone behind a truck having a bad minute is the thing worth seeing, and
   * an average taken here would flatten it before the rollup ever saw it.
   */
  noteVoice(stats: { lossPct: number; jitterMs: number; concealedPct: number }): void {
    this.voiceSamples.push(stats)
  }

  /**
   * One sampling pass. Public so tests can drive it with an injected clock.
   *
   * Guarded, because everything below it is synchronous `node:sqlite` running
   * inside a `setInterval` callback. `SQLITE_FULL`, `SQLITE_IOERR` and a
   * closed database all throw, and a throw from a timer with nothing above it
   * ends the process — so a box that filled its disk on day four of a
   * five-day festival did not lose its graphs, it lost its comms, once a
   * minute, for as long as anybody kept restarting it.
   *
   * The bucket is dropped rather than retried: a minute of monitoring is not
   * worth a growing batch thrown at a disk that has no room, and the next
   * minute starts clean. Said once rather than every minute, because filling
   * a log is how the disk got full.
   */
  sample(): void {
    try {
      this.collect()
    } catch (err) {
      // A source closure that threw. They are all reads of in-memory state,
      // so this is a bug rather than a disk — but a bug in a monitoring
      // read is still not worth a box.
      this.note(err)
    }
  }

  /**
   * Do one database write, and never let it end the box.
   *
   * The guard is here rather than around a whole pass because "it is working
   * again" has to mean a write succeeded. A pass with nothing to write
   * succeeds trivially, and one that announced recovery would alternate
   * between the two messages for as long as the disk stayed full — which is
   * how this was found.
   */
  private write(work: () => void): void {
    try {
      work()
      if (this.ailing) {
        this.ailing = false
        this.log('audit: the database is taking writes again')
      }
    } catch (err) {
      this.note(err)
    }
  }

  /** Say what went wrong, once, however long it goes on for. */
  private note(err: unknown): void {
    if (this.ailing) return
    this.ailing = true
    this.log(
      `audit: nothing is being recorded — the box is fine, its graphs are not (${reason(err)})`
    )
  }

  private collect(): void {
    const now = this.now()
    const bucket = bucketOf(now)
    if (bucket !== this.bucketStart) {
      this.flush(this.bucketStart)
      this.bucketStart = bucket
    }

    const next: PreviousSample = {
      grandmasterId: null,
      outageAts: new Set(),
      conflicts: new Set(),
      frozen: new Set(),
      sourceIds: new Map(),
      mediaKeys: new Set(),
      goodbyes: new Set(),
      watcherErrors: new Set(),
      watchPackets: null,
    }

    const stats = this.sources.hubStats()
    this.add('crew.connections', '', stats.connections)
    this.add('crew.onlineUsers', '', stats.onlineUsers)
    if (this.rttSamples.length > 0) {
      for (const ms of this.rttSamples) this.add('crew.rtt', '', ms)
      this.rttSamples = []
    }
    if (this.voiceSamples.length > 0) {
      for (const sample of this.voiceSamples) {
        this.add('voice.lossPct', '', sample.lossPct)
        this.add('voice.jitterMs', '', sample.jitterMs)
        this.add('voice.concealedPct', '', sample.concealedPct)
      }
      this.voiceSamples = []
    }

    if (this.sources.dmxHealth) this.sampleDmx(this.sources.dmxHealth(), next, now)
    if (this.sources.dmxOutages) this.sampleOutages(this.sources.dmxOutages(), next, now)
    if (this.sources.ptpStatus) this.samplePtp(this.sources.ptpStatus(now), next, now)
    if (this.sources.netwatchStatus) this.sampleWatch(this.sources.netwatchStatus(), next, now)
    if (this.sources.mdnsRoster) this.sampleMdns(this.sources.mdnsRoster(), next, now)
    if (this.sources.sapRoster) this.add('media.sapStreams', '', this.sources.sapRoster().length)

    this.previous = next

    if (now - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = now
      const metrics = this.metrics
      if (metrics) this.write(() => metrics.prune(now - RETENTION_MS))
    }
  }

  // -- per-source sampling ---------------------------------------------------

  private sampleDmx(health: UniverseHealth[], next: PreviousSample, now: number): void {
    for (const universe of health) {
      const key = String(universe.universe)
      const winner = universe.sources.find((s) => s.id === universe.winnerId)
      if (winner) {
        this.add('dmx.rateHz', key, winner.rateHz)
        // null means "cannot say" (sequencing off / empty window) — never 0%.
        if (winner.lossPct !== null) this.add('dmx.lossPct', key, winner.lossPct)
      }
      this.add('dmx.sources', key, universe.sources.length)

      if (universe.conflict) next.conflicts.add(universe.universe)
      if (universe.sync === 'frozen') next.frozen.add(universe.universe)
      next.sourceIds.set(universe.universe, new Set(universe.sources.map((s) => s.id)))

      const prev = this.previous
      if (prev) {
        const wasConflict = prev.conflicts.has(universe.universe)
        if (universe.conflict && !wasConflict) {
          this.event(
            now,
            'lighting',
            'dmx.conflict.start',
            key,
            `Universe ${key}: two sources at one priority`
          )
        } else if (!universe.conflict && wasConflict) {
          this.event(now, 'lighting', 'dmx.conflict.end', key, `Universe ${key}: conflict resolved`)
        }
        const wasFrozen = prev.frozen.has(universe.universe)
        if (universe.sync === 'frozen' && !wasFrozen) {
          this.event(
            now,
            'lighting',
            'dmx.sync.frozen',
            key,
            `Universe ${key}: stage frozen on its last look`
          )
        } else if (universe.sync !== 'frozen' && wasFrozen) {
          this.event(
            now,
            'lighting',
            'dmx.sync.recovered',
            key,
            `Universe ${key}: synchronisation recovered`
          )
        }
        const before = prev.sourceIds.get(universe.universe)
        if (before) {
          for (const id of next.sourceIds.get(universe.universe)!) {
            if (!before.has(id)) {
              const name = universe.sources.find((s) => s.id === id)?.name || id.slice(0, 8)
              this.event(
                now,
                'lighting',
                'dmx.source.appear',
                key,
                `Universe ${key}: ${name} started sending`
              )
            }
          }
          for (const id of before) {
            if (!next.sourceIds.get(universe.universe)!.has(id)) {
              this.event(
                now,
                'lighting',
                'dmx.source.gone',
                key,
                `Universe ${key}: a source stopped sending`
              )
            }
          }
        }
      }
    }
  }

  private sampleOutages(outages: DmxOutage[], next: PreviousSample, now: number): void {
    for (const outage of outages) {
      next.outageAts.add(outage.at)
      if (this.previous && !this.previous.outageAts.has(outage.at)) {
        this.event(
          now,
          'lighting',
          'dmx.outage',
          outage.protocol,
          `${outage.universes.length} universes went dark together` +
            (outage.otherProtocolAlive ? ' (the other protocol kept arriving)' : '')
        )
      }
    }
  }

  private samplePtp(clock: ClockStatus, next: PreviousSample, now: number): void {
    this.add('media.ptpAnnouncers', '', clock.announcers)
    this.add('media.ptpV1RateHz', '', clock.v1RateHz)
    next.grandmasterId = clock.grandmasterId
    if (this.previous && this.previous.grandmasterId !== clock.grandmasterId) {
      // Both directions are events: a change of master, or silence taking it.
      this.event(
        now,
        'media',
        'ptp.gm.change',
        clock.grandmasterId ?? '',
        clock.grandmasterId
          ? `PTP grandmaster is now ${clock.grandmasterId}`
          : 'PTP grandmaster went silent'
      )
    }
  }

  private sampleWatch(status: NetWatchStatus, next: PreviousSample, now: number): void {
    const packets = {
      ptp: status.ptp.packets,
      mdns: status.mdns.packets,
      sap: status.sap.packets,
    }
    const prevPackets = this.previous?.watchPackets
    if (prevPackets) {
      // Per-sample deltas of the monotonic counters; rollup sums the minute.
      this.add('watch.packets', 'ptp', Math.max(0, packets.ptp - prevPackets.ptp))
      this.add('watch.packets', 'mdns', Math.max(0, packets.mdns - prevPackets.mdns))
      this.add('watch.packets', 'sap', Math.max(0, packets.sap - prevPackets.sap))
    }
    next.watchPackets = packets

    for (const [name, watcher] of Object.entries({
      ptp: status.ptp,
      mdns: status.mdns,
      sap: status.sap,
    })) {
      if (watcher.error) next.watcherErrors.add(name)
      if (this.previous) {
        const had = this.previous.watcherErrors.has(name)
        if (watcher.error && !had) {
          this.event(now, 'media', 'watch.dark', name, `${name} watcher stopped: ${watcher.error}`)
        }
      }
    }
  }

  private sampleMdns(roster: MediaService[], next: PreviousSample, now: number): void {
    this.add('media.mdnsDevices', '', roster.length)
    for (const service of roster) {
      const key = `${service.kind}:${service.name}`
      next.mediaKeys.add(key)
      if (service.saidGoodbye) next.goodbyes.add(key)
      if (this.previous) {
        if (!this.previous.mediaKeys.has(key)) {
          this.event(
            now,
            'media',
            'media.device.appear',
            key,
            `${service.name} (${service.kind}) appeared`
          )
        } else if (service.saidGoodbye && !this.previous.goodbyes.has(key)) {
          this.event(
            now,
            'media',
            'media.device.gone',
            key,
            `${service.name} (${service.kind}) said goodbye`
          )
        }
      }
    }
  }

  // -- rollup + event plumbing ----------------------------------------------

  private add(metric: string, key: string, value: number): void {
    const id = `${metric} ${key}`
    const existing = this.accumulators.get(id)
    if (!existing) {
      // The key cap is per metric: count existing series for this metric.
      let keys = 0
      for (const k of this.accumulators.keys()) {
        if (k.startsWith(`${metric} `)) keys += 1
      }
      if (keys >= MAX_KEYS_PER_METRIC) return
    }
    this.accumulators.set(id, accumulate(existing, value))
  }

  private flush(bucket: number): void {
    if (this.accumulators.size === 0) return
    const rows: RollupRow[] = []
    for (const [id, acc] of this.accumulators) {
      const sep = id.indexOf(' ')
      rows.push({
        ts: bucket,
        metric: id.slice(0, sep),
        key: id.slice(sep + 1),
        min: acc.min,
        avg: acc.sum / acc.count,
        max: acc.max,
        count: acc.count,
      })
    }
    this.accumulators = new Map()
    // Cleared first, deliberately: a minute of monitoring is not worth
    // throwing an ever-growing batch at a disk that has no room for it, and
    // the next minute then starts clean.
    const metrics = this.metrics
    if (metrics) this.write(() => metrics.flush(rows))
  }

  private event(
    at: number,
    network: AuditEvent['network'],
    kind: string,
    key: string,
    detail: string
  ): void {
    const metrics = this.metrics
    if (!metrics) return
    this.write(() => {
      const hourAgo = at - 60 * 60_000
      const recent = metrics.countEventsSince(hourAgo)
      if (recent >= MAX_EVENTS_PER_HOUR) {
        // One marker so the report can say the hour was throttled, then silence.
        if (recent === MAX_EVENTS_PER_HOUR) {
          metrics.recordEvent({
            at,
            network,
            kind: 'events.throttled',
            key: '',
            detail: 'Event flood — recording paused for the rest of the hour',
          })
        }
        return
      }
      metrics.recordEvent({ at, network, kind, key, detail })
    })
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
