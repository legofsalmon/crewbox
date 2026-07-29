/**
 * What both lighting protocols reduce to.
 *
 * Art-Net and sACN disagree about almost everything at the byte level and
 * about a fair amount above it — one is little-endian with a 0-based universe
 * and no notion of priority, the other is big-endian, 1-based, and has a whole
 * arbitration model. Everything downstream of the two parsers works on this
 * one shape instead, so the state machine, the verdicts and the wire format to
 * clients are written once.
 *
 * Nothing in this directory transmits. See `listener.ts` for how that is
 * enforced rather than merely intended.
 */

export type DmxProtocol = 'artnet' | 'sacn'

/** sACN's default when a source doesn't care, and what Art-Net is treated as. */
export const DEFAULT_PRIORITY = 100

/** The most a legal sACN source may claim (E1.31 §6.2.3). */
export const MAX_PRIORITY = 200

/** Slots in a DMX universe. */
export const UNIVERSE_SIZE = 512

/**
 * How long a source may go quiet before it is treated as gone.
 *
 * **Both** protocols stop repeating themselves when nothing is changing —
 * that part is the same, and an earlier version of this comment had it wrong
 * by claiming sACN streams continuously. What differs is how often each one
 * checks in, and one timeout for both is a bug that only shows on a rig
 * sitting still:
 *
 * - **sACN** suppresses unchanged data after three identical packets, then
 *   sends a keep-alive every 800–1000 ms (E1.31 §6.6.2). The standard's own
 *   `E131_NETWORK_DATA_LOSS_TIMEOUT` is 2.5 s (§6.7.1, Appendix A), which
 *   comfortably tolerates two missed keep-alives.
 * - **Art-Net** re-transmits an unchanged frame only about every 4 seconds,
 *   and its merge timeout is 10. Judging it at sACN's 2.5 s drops a healthy
 *   console *between its own keep-alives*, so the panel flaps between
 *   "receiving" and "nothing arriving" for a rig parked on a look — which is
 *   most of a show.
 *
 * So the rule is the same for both: allow two missed keep-alives. The
 * numbers differ only because the intervals do.
 */
export const DATA_LOSS_MS: Record<DmxProtocol, number> = {
  sacn: 2500,
  artnet: 10_000,
}

/**
 * How long an Art-Net node keeps buffering after the last ArtSync.
 *
 * The Art-Net 4 specification's synchronisation section: a node "shall time
 * out to non-synchronous operation if an ArtSync is not received for 4
 * seconds or more". There is no per-packet sync field in ArtDmx, so this
 * timer is the entire difference between levels that are on stage and levels
 * a node is holding.
 */
export const ARTSYNC_TIMEOUT_MS = 4000

/**
 * How many sources an Art-Net node will merge.
 *
 * From the same specification's Data Merging section: merging is limited to
 * two sources, and "if there are more than two sources, the node shall ignore
 * the extra sources". So a third console on an Art-Net universe is not a
 * three-way argument — it is a console that is being silently discarded,
 * which is worth saying differently from a two-way conflict.
 */
export const ARTNET_MERGE_SOURCES = 2

/**
 * A universe's worth of levels from one source, at one moment.
 *
 * `slots` is index-0-for-slot-1, which is the opposite of how everyone says it
 * out loud ("channel 1") and the same as how every wire format stores it. The
 * conversion happens once, here, rather than being re-derived at each use.
 */
export interface DmxFrame {
  protocol: DmxProtocol
  /**
   * The universe exactly as it appeared on the wire — Art-Net's 0-based
   * Port-Address or sACN's 1-based universe. Mapping to a plot's numbering is
   * `state.ts`'s job and is deliberately not done here, so that what arrived
   * can always be shown next to what it was taken to mean.
   */
  wireUniverse: number
  /**
   * Stable identity for the sender. sACN gives a CID, which survives a change
   * of IP and distinguishes two sources behind one NAT. Art-Net has no such
   * field, so its sources are keyed by sender address and named later from any
   * ArtPollReply seen from the same address.
   */
  sourceId: string
  sourceName: string
  /** 0–200 for sACN; Art-Net has no priority, so DEFAULT_PRIORITY. */
  priority: number
  /** 0 means "not sequenced" in Art-Net; sACN always sequences. */
  sequence: number
  sequenced: boolean
  /** Up to 512 levels. Shorter is legal and common — a 24-way rig sends 24. */
  slots: Uint8Array
  /**
   * The universe this data is waiting on, when it is waiting on one.
   *
   * sACN carries a synchronization address. 0 means the data stands on its
   * own and is acted on immediately. Non-zero names a universe that
   * synchronization packets are sent on, and a receiver that is *also*
   * receiving that stream holds this packet until the next one arrives
   * (E1.31 §6.2.4.1) rather than outputting it.
   *
   * Both halves matter, and the second is easy to miss: §6.2.4.1 is explicit
   * that a receiver "must not attempt to synchronize any data on a
   * Synchronization Address until it has received its first E1.31
   * Synchronization Packet containing that address". A non-zero address on
   * its own therefore says the source *intends* synchronisation, not that
   * anything is being held — see `sync` in state.ts for the distinction.
   *
   * Art-Net has no per-packet equivalent; a node buffers from the moment it
   * sees an ArtSync until `ARTSYNC_TIMEOUT_MS` after the last one, so this is
   * always 0 there.
   */
  syncAddress: number
  /**
   * What the source wants receivers to do when synchronisation stops.
   *
   * E1.31 §6.2.6, options bit 5. Set means a receiver that was synchronised
   * may carry on acting on data packets as they arrive. **Clear** — the
   * default, and what most sources send — means components "shall not update
   * with any new packets until synchronization resumes": the rig freezes on
   * its last look.
   *
   * So a sync stream that stops is not a cosmetic fault. It is the difference
   * between a stage that keeps following the desk and a stage that stopped
   * moving several minutes ago, and this bit is which one.
   *
   * Art-Net reverts to non-synchronous operation on its own after four
   * seconds, which is the behaviour this bit describes when set — hence
   * `true` there.
   */
  forceSync: boolean
  /** Console preview, not the stage. Never counts as output. */
  preview: boolean
  /** The source says it is done with this universe. */
  terminated: boolean
}

/**
 * A node announcing itself. Listened for, never solicited — crewbox does not
 * send ArtPoll, so this only ever arrives because a node volunteered it.
 */
export interface ArtPollReply {
  ip: string
  shortName: string
  longName: string
}
