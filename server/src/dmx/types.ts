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

/** Slots in a DMX universe. */
export const UNIVERSE_SIZE = 512

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
