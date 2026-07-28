import { SEQUENCE_DISCARD_WINDOW } from './sacn.ts'
import { DATA_LOSS_MS, UNIVERSE_SIZE, type DmxFrame, type DmxProtocol } from './types.ts'

/**
 * What the lighting network is doing, kept in memory and never written down.
 *
 * This is the only part that decides anything. The parsers turn bytes into
 * frames; this turns frames into the two answers worth having — who is sending
 * what, and whether a given fixture is being sent to at all.
 *
 * Deliberately I/O-free. Everything here is a pure consequence of the frames
 * handed to `apply` and the clock passed with them, so the interesting cases
 * (a source going quiet, two consoles fighting, a straggling packet) are
 * ordinary unit tests rather than something that needs a rig.
 */

/** What a fixture's addresses have been seen doing. */
export type FixtureVerdict = 'no-data' | 'silent' | 'live'

export interface DmxSource {
  id: string
  name: string
  protocol: DmxProtocol
  priority: number
  lastSeen: number
  /** Packets per second, over the last completed second. */
  rateHz: number
}

export interface UniverseHealth {
  /** Plot-space universe, after the Art-Net base offset is applied. */
  universe: number
  /** What was on the wire, so a wrong mapping is visible rather than implied. */
  wireUniverse: number
  protocol: DmxProtocol
  sources: DmxSource[]
  /** The source whose levels are being believed, or null once all have gone. */
  winnerId: string | null
  /** Two or more sources at the top priority. Nobody can say who wins. */
  conflict: boolean
  lastSeen: number
  /** When this universe was first heard — the window the verdicts speak for. */
  since: number
}

interface SourceRecord extends DmxSource {
  /** Packets in the second currently being counted. */
  packets: number
  windowStart: number
  lastSequence: number
  hasSequence: boolean
}

interface UniverseRecord {
  universe: number
  wireUniverse: number
  protocol: DmxProtocol
  sources: Map<string, SourceRecord>
  winnerId: string | null
  lastSeen: number
  since: number
  slots: Uint8Array
  /**
   * Whether each slot has ever been above zero since we started listening.
   *
   * This is the whole of the `silent` verdict, and it costs 512 bytes per
   * universe. A fixture sitting at zero right now is indistinguishable from a
   * fixture nobody is addressing; a fixture that has been zero for the entire
   * window is a much stronger statement, and it is the one worth making.
   */
  everLit: Uint8Array
}

export interface DmxStateOptions {
  /** Plot universe that Art-Net universe 0 corresponds to. */
  artnetBase?: number
}

export class DmxState {
  private readonly universes = new Map<number, UniverseRecord>()
  private readonly artnetBase: number
  /** Art-Net sender IP → name, learned from any ArtPollReply it volunteered. */
  private readonly nodeNames = new Map<string, string>()

  constructor(options: DmxStateOptions = {}) {
    this.artnetBase = options.artnetBase ?? 1
  }

  /**
   * Wire universe → plot universe.
   *
   * Art-Net counts from 0 and a crewbox plot counts from 1, so the two are
   * offset by default. Getting this wrong moves every fixture by 512 channels,
   * which is invisible in paperwork and extremely visible on stage — hence a
   * configured base rather than an assumption, and hence `wireUniverse` being
   * carried all the way to the UI so both numbers can be shown together.
   */
  plotUniverse(frame: Pick<DmxFrame, 'protocol' | 'wireUniverse'>): number {
    return frame.protocol === 'artnet' ? frame.wireUniverse + this.artnetBase : frame.wireUniverse
  }

  /** Name an Art-Net sender from a reply it volunteered. */
  noteNode(ip: string, name: string): void {
    if (!name) return
    this.nodeNames.set(ip, name)
    for (const record of this.universes.values()) {
      const source = record.sources.get(ip)
      if (source) source.name = name
    }
  }

  /** Fold one frame in. `now` is passed rather than read so tests own the clock. */
  apply(frame: DmxFrame, now: number): void {
    // A preview is a console showing itself a cue it has not output. Counting
    // it would light up a plot for a rig that is dark.
    if (frame.preview) return

    const universe = this.plotUniverse(frame)
    let record = this.universes.get(universe)

    if (frame.terminated) {
      // Sources send this three times, so it has to be idempotent.
      record?.sources.delete(frame.sourceId)
      if (record) this.pickWinner(record)
      return
    }

    if (!record) {
      record = {
        universe,
        wireUniverse: frame.wireUniverse,
        protocol: frame.protocol,
        sources: new Map(),
        winnerId: null,
        lastSeen: now,
        since: now,
        slots: new Uint8Array(UNIVERSE_SIZE),
        everLit: new Uint8Array(UNIVERSE_SIZE),
      }
      this.universes.set(universe, record)
    }

    let source = record.sources.get(frame.sourceId)
    if (!source) {
      source = {
        id: frame.sourceId,
        name: frame.sourceName || this.nodeNames.get(frame.sourceId) || '',
        protocol: frame.protocol,
        priority: frame.priority,
        lastSeen: now,
        rateHz: 0,
        packets: 0,
        windowStart: now,
        lastSequence: frame.sequence,
        hasSequence: false,
      }
      record.sources.set(frame.sourceId, source)
    } else if (frame.sequenced && source.hasSequence) {
      // A packet that has fallen behind is a straggler the network reordered,
      // not the next frame. Applying it would flick levels backwards.
      const diff = signedByteDiff(frame.sequence, source.lastSequence)
      if (diff <= 0 && diff > -SEQUENCE_DISCARD_WINDOW) return
    }

    if (frame.sourceName) source.name = frame.sourceName
    source.priority = frame.priority
    source.lastSeen = now
    source.lastSequence = frame.sequence
    if (frame.sequenced) source.hasSequence = true

    source.packets++
    if (now - source.windowStart >= 1000) {
      source.rateHz = Math.round((source.packets * 1000) / (now - source.windowStart))
      source.packets = 0
      source.windowStart = now
    }

    record.lastSeen = now
    this.pickWinner(record)

    // Only the winning source's levels are believed. During a conflict that is
    // whichever of the tied sources spoke last, which is also what a real
    // receiver ends up showing.
    if (record.winnerId === frame.sourceId) {
      record.slots.fill(0, frame.slots.length)
      record.slots.set(frame.slots)
      for (let i = 0; i < frame.slots.length; i++) {
        if (frame.slots[i]! > 0) record.everLit[i] = 1
      }
    }
  }

  /**
   * Drop sources that have stopped sending. Call on a timer.
   *
   * The deadline is the sending protocol's, not one number for both — see
   * `DATA_LOSS_MS`. An Art-Net console parked on a look re-transmits only
   * every few seconds, and judging it by sACN's 2.5 s would report a healthy
   * rig as coming and going.
   */
  sweep(now: number): void {
    for (const record of this.universes.values()) {
      for (const [id, source] of record.sources) {
        if (now - source.lastSeen > DATA_LOSS_MS[source.protocol]) record.sources.delete(id)
      }
      this.pickWinner(record)
    }
  }

  /**
   * Highest priority wins; a tie is a conflict rather than a decision.
   *
   * E1.31 leaves what a receiver does with equal-priority sources
   * implementation-defined, which is precisely why two consoles patched to one
   * universe can run for a whole show before anybody notices. Reporting it is
   * most of the value.
   */
  private pickWinner(record: UniverseRecord): void {
    const sources = [...record.sources.values()]
    if (sources.length === 0) {
      record.winnerId = null
      return
    }
    const top = Math.max(...sources.map((s) => s.priority))
    const contenders = sources.filter((s) => s.priority === top)
    // Most recently heard among the top priority — stable when there is only
    // one, and honest about being arbitrary when there isn't.
    const winner = contenders.reduce((a, b) => (b.lastSeen >= a.lastSeen ? b : a))
    record.winnerId = winner.id
  }

  /** Everything known, in universe order. */
  health(): UniverseHealth[] {
    return [...this.universes.values()]
      .sort((a, b) => a.universe - b.universe)
      .map((record) => {
        const sources = [...record.sources.values()]
        const top = sources.length > 0 ? Math.max(...sources.map((s) => s.priority)) : 0
        return {
          universe: record.universe,
          wireUniverse: record.wireUniverse,
          protocol: record.protocol,
          // Only the public shape: the sequence and rate-window bookkeeping is
          // this class's business and has no meaning to a caller.
          sources: sources.map((source) => ({
            id: source.id,
            name: source.name,
            protocol: source.protocol,
            priority: source.priority,
            lastSeen: source.lastSeen,
            rateHz: source.rateHz,
          })),
          winnerId: record.winnerId,
          conflict: sources.filter((s) => s.priority === top).length > 1,
          lastSeen: record.lastSeen,
          since: record.since,
        }
      })
  }

  /** The winning source's current levels, or null if this universe is unknown. */
  levels(universe: number): Uint8Array | null {
    return this.universes.get(universe)?.slots ?? null
  }

  /** When this universe was first heard, for "since HH:MM" in the UI. */
  since(universe: number): number | null {
    return this.universes.get(universe)?.since ?? null
  }

  /**
   * The `everLit` record as 64 bytes, one bit per address, LSB first.
   *
   * Sent to clients so *they* decide each fixture's verdict: the plot is a
   * Yjs document the server has no business understanding, and 64 bytes
   * covers a whole universe however many fixtures are on it. It also only
   * ever gains bits, so it can be sent on change and never diffed.
   */
  everLitBitmap(universe: number): Uint8Array | null {
    const record = this.universes.get(universe)
    if (!record) return null
    const bits = new Uint8Array(UNIVERSE_SIZE / 8)
    for (let i = 0; i < UNIVERSE_SIZE; i++) {
      if (record.everLit[i]) bits[i >> 3]! |= 1 << (i & 7)
    }
    return bits
  }

  /**
   * What can honestly be said about a fixture.
   *
   * `address` is 1-based, the way everyone says it; the slot array is not.
   * `silent` never means broken — it means nothing has been sent to these
   * addresses for as long as we have been listening, which is a fact about the
   * listening window as much as about the rig.
   */
  verdict(universe: number, address: number, footprint: number): FixtureVerdict {
    const record = this.universes.get(universe)
    if (!record) return 'no-data'
    if (address < 1 || address > UNIVERSE_SIZE) return 'no-data'
    const from = address - 1
    const to = Math.min(from + Math.max(1, footprint), UNIVERSE_SIZE)
    for (let i = from; i < to; i++) {
      if (record.everLit[i]) return 'live'
    }
    return 'silent'
  }

  /** Forget everything. Used when listening is turned off. */
  clear(): void {
    this.universes.clear()
    this.nodeNames.clear()
  }
}

/**
 * `a - b` as a signed 8-bit difference, so 1 is two *ahead* of 255 rather than
 * 254 behind it. Sequence numbers wrap at 256, and a wrap read as a huge jump
 * backwards would discard a run of good packets every time round.
 */
export function signedByteDiff(a: number, b: number): number {
  return ((a - b + 128) & 0xff) - 128
}
