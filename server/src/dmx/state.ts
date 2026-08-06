import { DISCOVERY_TIMEOUT_MS, SEQUENCE_DISCARD_WINDOW, type SacnDiscovery } from './sacn.ts'
import {
  ARTSYNC_TIMEOUT_MS,
  DATA_LOSS_MS,
  UNIVERSE_SIZE,
  type ArtPollReply,
  type DmxFrame,
  type DmxProtocol,
} from './types.ts'

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

/**
 * Whether the levels on the wire are the levels on stage.
 *
 * Universe synchronisation exists so that several universes land together —
 * a source sends the data, then sends a synchronization packet, and receivers
 * output everything they were holding at once (E1.31 §11, Art-Net's ArtSync).
 * It is used for media servers, LED panels and anything where a split-second
 * of skew is visible.
 *
 * For a monitor it changes what a level *means*, so it cannot be ignored:
 *
 * - `none` — data stands on its own. What is on the wire is on stage. The
 *   ordinary case, and what most rigs do.
 * - `held` — the data is sync-addressed and the sync stream is arriving, so
 *   a conforming receiver is holding these levels until the next
 *   synchronization packet. They are queued, not output.
 * - `frozen` — sync-addressed, the sync universe *is* being listened to,
 *   nothing has arrived on it for the data-loss timeout (§11.1.2), and the
 *   source's force-synchronization bit is clear. §6.2.6 is unambiguous about
 *   what that means: receivers "shall not update with any new packets until
 *   synchronization resumes". The stage is stuck on its last look while the
 *   desk carries on sending, and neither end can see it from where it is
 *   standing. This is the fault worth building the whole thing for.
 * - `lost` — the same, but with force-synchronization set, so receivers were
 *   free to carry on unsynchronised. Milder — the stage is following the desk
 *   again — but the multi-universe timing the source asked for is gone, which
 *   is what it was configured for.
 * - `unwatched` — sync-addressed to a universe this box has not joined, so
 *   whether it is `held`, `frozen` or `lost` is unknowable. §6.3.3.1 sends
 *   synchronization packets only to their own universe's multicast group, so
 *   this happens whenever the sync universe isn't in `CREWBOX_DMX_UNIVERSES`
 *   — and the fix is to add it.
 */
export type DmxSyncState = 'none' | 'held' | 'frozen' | 'lost' | 'unwatched'

export interface DmxSource {
  id: string
  name: string
  protocol: DmxProtocol
  priority: number
  lastSeen: number
  /** Packets per second, over the last completed second. */
  rateHz: number
  /**
   * Fraction of this source's frames that never arrived, over the last
   * completed `LOSS_WINDOW_MS` — measured from gaps in the sequence numbers
   * both protocols already carry, so it costs nothing and transmits nothing.
   *
   * `null` is "cannot say", and it is load-bearing: an Art-Net source with
   * sequencing disabled (sequence 0) has no gaps to count, and a window in
   * which nothing arrived proves nothing — both protocols suppress unchanged
   * frames, so absence is normal, not loss. Reporting 0% in either case
   * would be the panel inventing evidence.
   */
  lossPct: number | null
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
  /** Whether these levels are on stage, being held, or stuck. */
  sync: DmxSyncState
  /**
   * The universe synchronization packets for this data are sent on, or 0.
   *
   * Carried because it is the actionable part: a `unwatched` verdict is
   * fixed by adding this number to the box's universe list, and a `lost` one
   * is diagnosed by looking at what is meant to be sending on it.
   */
  syncAddress: number
  lastSeen: number
  /** When this universe was first heard — the window the verdicts speak for. */
  since: number
}

/**
 * What a source says it is transmitting on, without anyone having to join a
 * single one of those groups to find out.
 *
 * This is E1.31's own answer to the problem crewbox has: §12 says universe
 * discovery is "specifically intended to reduce the imposed load on a network
 * that would otherwise be created by a monitoring system joining every single
 * E1.31 multicast group in order to probe its traffic to report this same
 * information". That monitoring system is this one.
 */
export interface DiscoveredSource {
  id: string
  name: string
  /** Every universe advertised across the pages seen, sorted. */
  universes: number[]
  /**
   * Whether every page of the list has actually arrived.
   *
   * §6.7.1.1 warns that pages "may be dropped or arrive out of order,
   * potentially even mixed in between different runs of pages", and leaves
   * the response to receivers. Waiting for a complete set would report
   * nothing at all when one page keeps getting lost; reporting the union
   * without saying so would present a partial list as the whole truth. So:
   * report the union, and say which it is.
   */
  complete: boolean
  /** Pages seen out of `lastPage + 1`. Only interesting when incomplete. */
  pagesSeen: number
  pages: number
  lastSeen: number
}

interface DiscoveryRecord {
  id: string
  name: string
  /** page number → { universes, when } so a stale page can be aged out alone. */
  pages: Map<number, { universes: number[]; at: number }>
  lastPage: number
  lastSeen: number
}

interface SourceRecord extends DmxSource {
  /** Packets in the second currently being counted. */
  packets: number
  windowStart: number
  lastSequence: number
  hasSequence: boolean
  /** Sequenced frames that arrived in the loss window being counted. */
  lossReceived: number
  /** Frames the sequence numbers say were skipped over in that window. */
  lossMissed: number
  lossWindowStart: number
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
  /** The winning source's synchronization address, 0 when it isn't using one. */
  syncAddress: number
  /** The winning source's force-synchronization bit. See `DmxFrame`. */
  forceSync: boolean
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

/**
 * Loss is judged over this window. Long enough that one dropped frame at
 * 30 Hz reads as a third of a percent rather than a spike, short enough that
 * "losing frames" means now, not ten minutes ago.
 */
export const LOSS_WINDOW_MS = 10_000

/**
 * A forward sequence jump bigger than this is read as the source restarting
 * its sequence (console reboot, stream restart), not as that many frames
 * lost in one gulp. A real gap this size at show rates is over a second of
 * silence, which the data-loss timeout reports as its own, louder fault.
 */
const LOSS_RESTART_GAP = 40

/**
 * How close together universes must fall silent to be read as one event.
 * Both protocols spread their keep-alives over at most a second, so a cable
 * pull kills every universe within roughly one keep-alive interval plus one
 * sweep — 4 s covers that with slack without capturing coincidences.
 */
const OUTAGE_CORRELATION_MS = 4000

/** How long a silence stays eligible for correlation before it is history. */
const SILENCE_MEMORY_MS = 15_000

/**
 * How long a universe with no sources is kept before it is forgotten.
 *
 * A universe record is deliberately kept after its last source goes, so the
 * panel can say "this was live, now nothing" rather than forgetting a fault.
 * But each record holds two 512-byte arrays, and Art-Net's 15-bit
 * Port-Address plus sACN's 16-bit universe mean a misconfigured — or
 * hostile — sender can name tens of thousands of them. Over a five-day box
 * that is unbounded growth. An hour of silence is far longer than any real
 * "just went dark" needs, and shorter than the event; past it, the record is
 * dropped and re-created for free if the universe ever comes back.
 */
const UNIVERSE_RETENTION_MS = 60 * 60_000

/**
 * Several universes going dark together, which no desk does.
 *
 * One universe going quiet is a fault about its source. Every universe of a
 * protocol going quiet within moments of each other is a fault about the
 * *path* — a pulled cable, a dead switch, IGMP snooping losing its querier —
 * and reporting it as N separate silences sends someone to check N desks
 * that are all fine. This is the check that turns the RUNBOOK's IGMP
 * folklore into a named diagnosis.
 */
export interface DmxOutage {
  protocol: DmxProtocol
  /** When the collapse completed — the moment the last universe went dark. */
  at: number
  /** Plot universes that went silent together. */
  universes: number[]
  /**
   * Whether the other protocol was still arriving when this one collapsed.
   * The sharpest version of the diagnosis: sACN is multicast and Art-Net is
   * broadcast, so "multicast died while broadcast lives" is IGMP/switch
   * behaviour to a first approximation, not a desk and not a cable.
   */
  otherProtocolAlive: boolean
}

/** An Art-Net node that has announced itself. Overheard, never solicited. */
export interface ArtNode {
  ip: string
  /** The node's short name, as configured on the node itself. */
  name: string
  longName: string
  firstSeen: number
  lastSeen: number
}

export interface DmxStateOptions {
  /** Plot universe that Art-Net universe 0 corresponds to. */
  artnetBase?: number
}

export class DmxState {
  private readonly universes = new Map<number, UniverseRecord>()
  private readonly artnetBase: number
  /**
   * Every Art-Net node that has announced itself, kept for the session.
   * Never aged out: a node that stopped replying is exactly the news an
   * inventory exists to carry, and `lastSeen` is how it carries it.
   */
  private readonly artNodes = new Map<string, ArtNode>()
  /** Universes that recently lost their last source, for outage correlation. */
  private readonly recentSilences: Array<{ universe: number; protocol: DmxProtocol; at: number }> =
    []
  /** Protocol → the collapse currently in effect. Cleared when data returns. */
  private readonly activeOutages = new Map<DmxProtocol, DmxOutage>()
  /**
   * sACN sync universe → when a synchronization packet was last seen on it.
   *
   * Keyed by sync address rather than by source: §11.2.1 says two sources
   * synchronising the same address is "beyond the scope of this standard, and
   * may cause unpredictable behavior", so what matters to a receiver is only
   * whether the stream exists at all.
   */
  private readonly sacnSync = new Map<number, number>()
  /** When the last ArtSync arrived. Art-Net's is one timer for the network. */
  private artSyncAt: number | null = null
  /**
   * sACN universes whose multicast group this box has actually joined.
   *
   * Needed to tell "no synchronization packets are being sent" from "we
   * wouldn't have heard them if they were" — see `DmxSyncState`. Empty means
   * unknown, which reads as `unwatched` rather than as `lost`: claiming a
   * fault we cannot see would be exactly the cry-wolf the per-protocol
   * timeout fix was about.
   */
  private joinedUniverses = new Set<number>()
  /** CID → what that source last advertised it is transmitting on. */
  private readonly discovery = new Map<string, DiscoveryRecord>()

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

  /**
   * An Art-Net node announced itself (in a reply to somebody else's poll —
   * crewbox never polls). Recorded for the inventory whether or not it has a
   * name; used to label sources when it does.
   */
  noteNode(reply: ArtPollReply, now: number): void {
    let node = this.artNodes.get(reply.ip)
    if (!node) {
      node = { ip: reply.ip, name: '', longName: '', firstSeen: now, lastSeen: now }
      this.artNodes.set(reply.ip, node)
    }
    node.lastSeen = now
    if (reply.shortName) node.name = reply.shortName
    if (reply.longName) node.longName = reply.longName
    const label = reply.longName || reply.shortName
    if (!label) return
    for (const record of this.universes.values()) {
      const source = record.sources.get(reply.ip)
      if (source) source.name = label
    }
  }

  /** Every node that has announced itself this session, stalest last. */
  nodes(): ArtNode[] {
    return [...this.artNodes.values()].sort(
      (a, b) => b.lastSeen - a.lastSeen || (a.name || a.ip).localeCompare(b.name || b.ip)
    )
  }

  /** Collapses currently in effect — see DmxOutage. */
  outages(): DmxOutage[] {
    return [...this.activeOutages.values()]
  }

  /** Which sACN groups are actually joined, so `lost` can be told from unheard. */
  watchSyncUniverses(universes: number[]): void {
    this.joinedUniverses = new Set(universes)
  }

  /** An sACN synchronization packet arrived for this sync universe. */
  noteSacnSync(syncAddress: number, now: number): void {
    this.sacnSync.set(syncAddress, now)
  }

  /**
   * An ArtSync arrived.
   *
   * Not recorded per universe or per sender: ArtSync is broadcast and carries
   * no port address, so every node on the network starts buffering. One timer
   * is the whole of what the protocol offers.
   */
  noteArtSync(now: number): void {
    this.artSyncAt = now
  }

  /**
   * Fold in one page of a source's universe advertisement.
   *
   * Pages are stored individually rather than merged into a running set, so
   * that a source dropping a universe is eventually reflected: each page
   * carries its own timestamp and ages out on its own. Merging into one set
   * would mean a universe advertised once was advertised forever.
   *
   * `lastPage` shrinking is taken as a new, shorter run and the pages past it
   * are dropped immediately — a desk that has been unpatched from half its
   * universes should say so within one interval, not two.
   */
  noteDiscovery(packet: SacnDiscovery, now: number): void {
    let record = this.discovery.get(packet.sourceId)
    if (!record) {
      record = {
        id: packet.sourceId,
        name: packet.sourceName,
        pages: new Map(),
        lastPage: packet.lastPage,
        lastSeen: now,
      }
      this.discovery.set(packet.sourceId, record)
    }
    if (packet.sourceName) record.name = packet.sourceName
    record.lastPage = packet.lastPage
    record.lastSeen = now
    record.pages.set(packet.page, { universes: packet.universes, at: now })
    for (const page of record.pages.keys()) {
      if (page > packet.lastPage) record.pages.delete(page)
    }
  }

  /** Every source that has advertised itself, and what it claims. */
  discovered(): DiscoveredSource[] {
    return [...this.discovery.values()]
      .map((record) => {
        const universes = new Set<number>()
        for (const page of record.pages.values()) {
          for (const universe of page.universes) universes.add(universe)
        }
        const pages = record.lastPage + 1
        return {
          id: record.id,
          name: record.name,
          universes: [...universes].sort((a, b) => a - b),
          complete: record.pages.size === pages,
          pagesSeen: record.pages.size,
          pages,
          lastSeen: record.lastSeen,
        }
      })
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
  }

  /** Fold one frame in. `now` is passed rather than read so tests own the clock. */
  apply(frame: DmxFrame, now: number): void {
    // A preview is a console showing itself a cue it has not output. Counting
    // it would light up a plot for a rig that is dark.
    if (frame.preview) return

    // Anything arriving at all — data, even a termination — proves the path
    // for this protocol delivers again, which is the end of an outage.
    this.activeOutages.delete(frame.protocol)

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
        syncAddress: 0,
        forceSync: false,
        everLit: new Uint8Array(UNIVERSE_SIZE),
      }
      this.universes.set(universe, record)
    }

    let source = record.sources.get(frame.sourceId)
    if (!source) {
      const node = this.artNodes.get(frame.sourceId)
      source = {
        id: frame.sourceId,
        name: frame.sourceName || (node ? node.longName || node.name : ''),
        protocol: frame.protocol,
        priority: frame.priority,
        lastSeen: now,
        rateHz: 0,
        lossPct: null,
        packets: 0,
        windowStart: now,
        lastSequence: frame.sequence,
        hasSequence: false,
        lossReceived: 0,
        lossMissed: 0,
        lossWindowStart: now,
      }
      record.sources.set(frame.sourceId, source)
    } else if (frame.sequenced && source.hasSequence) {
      const diff = signedByteDiff(frame.sequence, source.lastSequence)
      if (diff <= 0 && diff > -SEQUENCE_DISCARD_WINDOW) {
        // A packet that has fallen behind is a straggler the network
        // reordered, not the next frame. Applying it would flick levels
        // backwards — but its arrival is still evidence: the frame counted
        // missing when it was skipped over did exist, so it was reordered,
        // not lost. The loss figure should not carry it.
        if (source.lossMissed > 0) {
          source.lossMissed--
          source.lossReceived++
        }
        return
      }
      // The frames a forward jump skipped over never arrived. Jumps past
      // LOSS_RESTART_GAP read as the source restarting its sequence — a real
      // gap that size is over a second of silence at show rates, which the
      // data-loss timeout reports as its own fault.
      if (diff > 1 && diff <= LOSS_RESTART_GAP) {
        let missed = diff - 1
        // Art-Net skips sequence 0 (0 means "sequencing disabled"), so a
        // healthy stream wraps 255 → 1. That one step reads as diff 2, and
        // without this correction it is charged as a lost frame every
        // 255-frame cycle — a steady ~0.4% phantom loss on every sequencing
        // Art-Net source. When the skipped-over span crosses 0
        // (lastSequence + diff >= 257), one of those numbers is 0 and was
        // never going to arrive.
        if (frame.protocol === 'artnet' && source.lastSequence + diff >= 257) missed -= 1
        source.lossMissed += missed
      }
    }

    if (frame.sourceName) source.name = frame.sourceName
    source.priority = frame.priority
    source.lastSeen = now
    source.lastSequence = frame.sequence
    if (frame.sequenced) {
      source.hasSequence = true
      source.lossReceived++
    }

    source.packets++
    if (now - source.windowStart >= 1000) {
      source.rateHz = Math.round((source.packets * 1000) / (now - source.windowStart))
      source.packets = 0
      source.windowStart = now
    }
    this.rollLoss(source, now)

    record.lastSeen = now
    this.pickWinner(record)

    // Only the winning source's levels are believed. During a conflict that is
    // whichever of the tied sources spoke last, which is also what a real
    // receiver ends up showing.
    if (record.winnerId === frame.sourceId) {
      record.slots.fill(0, frame.slots.length)
      record.slots.set(frame.slots)
      // Deliberately recorded even when the data is being held for
      // synchronisation. `everLit` answers "is the desk sending to these
      // addresses", which is a question about the desk and the patch, and the
      // answer is yes whether or not a receiver has been told to take it. The
      // separate `sync` verdict is what says the levels may not be on stage.
      for (let i = 0; i < frame.slots.length; i++) {
        if (frame.slots[i]! > 0) record.everLit[i] = 1
      }
      record.syncAddress = frame.syncAddress
      record.forceSync = frame.forceSync
    }
  }

  /**
   * Whether a universe's levels are on stage. See `DmxSyncState`.
   *
   * `now` is only needed for Art-Net, whose sync state is a timer rather than
   * a stream — sACN's expiry happens in `sweep`, so its answer here is a
   * lookup.
   */
  private syncState(record: UniverseRecord): DmxSyncState {
    if (record.protocol === 'artnet') {
      // No per-packet address, so it is one question: has a node been told to
      // buffer recently enough that it still is? `sweep` clears the timer.
      return this.artSyncAt === null ? 'none' : 'held'
    }
    if (record.syncAddress === 0) return 'none'
    if (this.sacnSync.has(record.syncAddress)) return 'held'
    // A sync universe we never joined would look identical to one nobody is
    // sending on. Only the joined case can honestly be called a failure.
    if (!this.joinedUniverses.has(record.syncAddress)) return 'unwatched'
    return record.forceSync ? 'lost' : 'frozen'
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
      const hadSources = record.sources.size > 0
      for (const [id, source] of record.sources) {
        if (now - source.lastSeen > DATA_LOSS_MS[source.protocol]) record.sources.delete(id)
        // Windows close on the clock, not only on arrival, so a source that
        // slowed to keep-alives still gets a verdict — and one that stopped
        // entirely decays to "cannot say" rather than freezing its last
        // number on screen.
        else this.rollLoss(source, now)
      }
      this.pickWinner(record)
      if (hadSources && record.sources.size === 0) {
        this.recentSilences.push({ universe: record.universe, protocol: record.protocol, at: now })
      }
      // Forget a universe nothing has sent to for an hour. Keeping it is what
      // lets the panel say "was live, now nothing"; keeping it forever is how
      // a box on a busy or hostile network accretes tens of thousands of
      // 1 KB records over a multi-day event. The record costs nothing to
      // rebuild if the universe ever returns.
      if (record.sources.size === 0 && now - record.lastSeen > UNIVERSE_RETENTION_MS) {
        this.universes.delete(record.universe)
      }
    }

    // Correlate the silences: every universe of a protocol going dark within
    // one window is one event about the path, not many about the desks.
    while (this.recentSilences.length > 0 && now - this.recentSilences[0]!.at > SILENCE_MEMORY_MS) {
      this.recentSilences.shift()
    }
    for (const protocol of ['sacn', 'artnet'] as const) {
      if (this.activeOutages.has(protocol)) continue
      const together = this.recentSilences.filter(
        (s) => s.protocol === protocol && now - s.at <= OUTAGE_CORRELATION_MS
      )
      // One universe going quiet is a fact about its source. Two is the
      // smallest number that can implicate the path instead — and only if
      // nothing of this protocol survived: a partial collapse still has a
      // working path to this box, so the survivors exonerate the network.
      if (together.length < 2) continue
      const records = [...this.universes.values()]
      if (records.some((r) => r.protocol === protocol && r.sources.size > 0)) continue
      this.activeOutages.set(protocol, {
        protocol,
        at: Math.max(...together.map((s) => s.at)),
        universes: [...new Set(together.map((s) => s.universe))].sort((a, b) => a - b),
        otherProtocolAlive: records.some((r) => r.protocol !== protocol && r.sources.size > 0),
      })
    }

    // Sync streams age out here too, for the same reason and on the same
    // timer as the class's own I/O-free contract: nothing tells us a stream
    // stopped, and `health()` stays a pure read of what `apply` and `sweep`
    // have been told rather than reaching for a clock of its own.
    for (const [universe, seen] of this.sacnSync) {
      // §11.1.2: a synchronized receiver stops synchronizing if no
      // synchronization packet arrives on that universe within
      // E131_NETWORK_DATA_LOSS_TIMEOUT.
      if (now - seen > DATA_LOSS_MS.sacn) this.sacnSync.delete(universe)
    }
    if (this.artSyncAt !== null && now - this.artSyncAt > ARTSYNC_TIMEOUT_MS) {
      this.artSyncAt = null
    }

    // Advertisements age page by page, so a source that dropped a universe
    // stops claiming it once that page goes stale, rather than only when the
    // whole source does.
    for (const [id, record] of this.discovery) {
      for (const [page, seen] of record.pages) {
        if (now - seen.at > DISCOVERY_TIMEOUT_MS) record.pages.delete(page)
      }
      if (record.pages.size === 0) this.discovery.delete(id)
    }
  }

  /**
   * Highest priority wins; a tie is a conflict, resolved the same way every
   * time.
   *
   * E1.31 §6.2.3.3 is explicit that a receiver should not pick between
   * equal-priority sources in a way that "generate[s] different results from
   * the same source combination on different occasions", because it makes a
   * network hard to troubleshoot. It names order-of-arrival schemes as the
   * example not to follow — which is what this used to be: whichever console
   * spoke last won, so the same two desks produced different answers
   * depending on packet timing, and the levels flipped between them.
   *
   * For a tool whose whole job is troubleshooting somebody's network, that is
   * the wrong failure mode. So: lowest source id wins. A CID is stable across
   * IP changes and reboots, so the same two desks always give the same
   * answer, and the answer doesn't move while you are looking at it.
   *
   * The choice is arbitrary and is meant to be — it is not a merge. The
   * useful output here is `conflict`, which says nobody can know what the
   * rig is really doing. §6.2.3.4 and §6.2.3.5 require a receiver to declare
   * both this algorithm and its behaviour when sources are exceeded, which is
   * why they are written down here and in docs/DMX_MONITORING.md.
   */
  private pickWinner(record: UniverseRecord): void {
    const sources = [...record.sources.values()]
    if (sources.length === 0) {
      record.winnerId = null
      // Nothing is being sent, so nothing is being held. Leaving the last
      // winner's sync address behind would keep reporting a universe as
      // frozen long after the source that asked for synchronisation went
      // away — a fault attributed to a rig nobody is sending to.
      record.syncAddress = 0
      record.forceSync = false
      return
    }
    const top = Math.max(...sources.map((s) => s.priority))
    const winner = sources.filter((s) => s.priority === top).reduce((a, b) => (b.id < a.id ? b : a))
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
            lossPct: source.lossPct,
          })),
          winnerId: record.winnerId,
          conflict: sources.filter((s) => s.priority === top).length > 1,
          sync: this.syncState(record),
          syncAddress: record.syncAddress,
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

  /**
   * Close a source's loss window when it is due, and publish the verdict.
   *
   * A window nothing arrived in publishes `null`, not 0% and not 100%: both
   * protocols stop repeating themselves when nothing changes, so an empty
   * window is silence by design and proves nothing about the path.
   */
  private rollLoss(source: SourceRecord, now: number): void {
    if (now - source.lossWindowStart < LOSS_WINDOW_MS) return
    const total = source.lossReceived + source.lossMissed
    source.lossPct = total > 0 ? source.lossMissed / total : null
    source.lossReceived = 0
    source.lossMissed = 0
    source.lossWindowStart = now
  }

  /** Forget everything. Used when listening is turned off. */
  clear(): void {
    this.universes.clear()
    this.artNodes.clear()
    this.sacnSync.clear()
    this.joinedUniverses.clear()
    this.discovery.clear()
    this.recentSilences.length = 0
    this.activeOutages.clear()
    this.artSyncAt = null
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
