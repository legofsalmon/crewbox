import dgram from 'node:dgram'
import {
  gradeReading,
  type ProcessorReading,
  type ProcessorState,
  type ProcessorStatus,
  type VideoProcessor,
  type VideoReadPath,
} from '@crewbox/shared'
import { CoexReader, readingIsEmpty, type CoexIo, type ReadOnlyInit } from './coex.ts'
import { SnmpSession, readOverSnmp, type SnmpIo } from './snmp.ts'
import type { VideoStore } from './store.ts'

/**
 * Polls the processors an admin has turned on, and nothing else.
 *
 * The resting state of this class is silence. It holds no sockets between
 * polls, contacts nothing that is not in the list with `monitored` set, and
 * stops the moment that flag goes off. A box whose video module is enabled
 * but has nothing armed puts exactly nothing on a video network.
 *
 * Cadence follows novasun's recommendation — status every 20 s, topology
 * every tenth poll, well inside the 10–30 s band it suggests and far below
 * anything a controller is likely to notice.
 */

/** Between polls of one processor. */
export const POLL_INTERVAL_MS = 20_000

/**
 * Consecutive failures before a processor is called unreachable.
 *
 * Two, not one: a single dropped UDP datagram or a controller mid-reboot is
 * not a fault worth putting on a screen, and a pane that flickers red is one
 * people stop reading.
 */
export const MISSES_BEFORE_UNREACHABLE = 2

/**
 * Failures before the read path is worked out again from scratch.
 *
 * The chosen path is cached, so an HTTP-only controller does not eat an SNMP
 * timeout on every poll. But a controller that had SNMP switched on between
 * shows should be picked up without restarting the box, so a run of failures
 * throws the cached answer away.
 */
export const MISSES_BEFORE_REPROBE = 3

export interface WatcherIo {
  coex: CoexIo
  snmp: SnmpIo
  now: () => number
}

export const realWatcherIo: WatcherIo = {
  coex: {
    fetch: (url: string, init: ReadOnlyInit) => fetch(url, init),
    now: () => Date.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
  snmp: {
    createSocket: (options) => dgram.createSocket(options),
    now: () => Date.now(),
  },
  now: () => Date.now(),
}

interface Watched {
  host: string
  reader: CoexReader
  session: SnmpSession
  /** What worked last time, so the next poll starts with the right one. */
  path: VideoReadPath | null
  reading: ProcessorReading | null
  lastHeard: number | null
  misses: number
}

export interface WatcherOptions {
  store: VideoStore
  io?: WatcherIo
  community?: string
  log?: { warn: (msg: string) => void }
}

export class VideoWatcher {
  private readonly store: VideoStore
  private readonly io: WatcherIo
  private readonly community: string
  private readonly log: WatcherOptions['log']
  private readonly watched = new Map<string, Watched>()
  private timer: NodeJS.Timeout | null = null
  private polling = false

  constructor(options: WatcherOptions) {
    this.store = options.store
    this.io = options.io ?? realWatcherIo
    this.community = options.community ?? 'public'
    this.log = options.log
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.watched.clear()
  }

  /**
   * Poll every armed processor once.
   *
   * Public so a route can ask for a reading straight after an admin arms one
   * — waiting 20 s to find out whether the address was right is a bad first
   * impression of a pane whose whole job is telling you things promptly.
   *
   * Never throws, and never runs twice at once: a slow controller must not
   * cause two polls to overlap and double the traffic.
   */
  async tick(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const armed = this.store.list().filter((p) => p.monitored)
      for (const [id] of this.watched) {
        if (!armed.some((p) => p.id === id)) this.watched.delete(id)
      }
      for (const processor of armed) {
        try {
          await this.pollOne(processor)
        } catch (err) {
          // A reader that throws is a bug here, not a network condition —
          // both clients are written to degrade. Log it and keep the rest of
          // the wall on screen.
          this.log?.warn(`video: polling ${processor.host} threw: ${String(err)}`)
        }
      }
    } finally {
      this.polling = false
    }
  }

  private entryFor(processor: VideoProcessor): Watched {
    const existing = this.watched.get(processor.id)
    // Keyed by id but rebuilt when the address changes, so an edited entry
    // does not keep reading the old controller.
    if (existing && existing.host === processor.host) return existing
    const fresh: Watched = {
      host: processor.host,
      reader: new CoexReader(processor.host, this.io.coex),
      session: new SnmpSession(processor.host, this.io.snmp, this.community),
      path: null,
      reading: null,
      lastHeard: null,
      misses: 0,
    }
    this.watched.set(processor.id, fresh)
    return fresh
  }

  private async pollOne(processor: VideoProcessor): Promise<void> {
    const entry = this.entryFor(processor)
    if (entry.misses >= MISSES_BEFORE_REPROBE) entry.path = null

    // SNMP first when we have no reason to prefer otherwise: it is what
    // NovaStar publishes for monitoring and it carries more than the HTTP
    // API does. A controller without it costs one timeout, once, because the
    // answer is then cached.
    const order: VideoReadPath[] = entry.path === 'http' ? ['http', 'snmp'] : ['snmp', 'http']

    for (const path of order) {
      const reading =
        path === 'snmp'
          ? await readOverSnmp(entry.session, this.io.now())
          : await entry.reader.poll()
      if (readingIsEmpty(reading)) continue
      entry.path = path
      entry.reading = reading
      entry.lastHeard = reading.at
      entry.misses = 0
      return
    }

    entry.misses++
    // The last good reading is kept: "eight cabinets, last heard 21:40" is
    // more use at 21:45 than an empty row, and the state says it is stale.
    // Only an address that has never answered has nothing worth keeping.
    if (entry.lastHeard === null) entry.reading = null
  }

  /** What the pane renders. Cheap, synchronous, and safe to call per request. */
  statuses(): ProcessorStatus[] {
    return this.store.list().map((processor) => {
      const entry = this.watched.get(processor.id)
      const reading = entry?.reading ?? null
      const state = this.stateOf(processor, entry)
      const graded = gradeReading(state === 'watching' ? reading : null)
      return {
        processor,
        state,
        health: state === 'unreachable' || state === 'no-read-path' ? 'fault' : graded.health,
        summary: this.summaryOf(state, graded.summary),
        reading,
        lastHeard: entry?.lastHeard ?? null,
        misses: entry?.misses ?? 0,
      }
    })
  }

  private stateOf(processor: VideoProcessor, entry: Watched | undefined): ProcessorState {
    if (!processor.monitored) return 'listed'
    if (!entry || entry.misses === 0) return 'watching'
    if (entry.misses < MISSES_BEFORE_UNREACHABLE) return 'watching'
    // Never having had an answer is a different claim from having lost one.
    // The first may be a model with no read-only interface at all; the second
    // is a processor that has gone away.
    return entry.lastHeard === null ? 'no-read-path' : 'unreachable'
  }

  private summaryOf(state: ProcessorState, graded: string): string {
    if (state === 'listed') return 'not being watched'
    if (state === 'unreachable') return 'no answer'
    // The honest version: crewbox cannot tell an absent processor from a
    // VX4S, because telling them apart means opening the register bus.
    if (state === 'no-read-path') return 'nothing to read — see the note'
    return graded
  }
}
