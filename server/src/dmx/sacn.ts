import { MAX_PRIORITY, UNIVERSE_SIZE, type DmxFrame } from './types.ts'

/**
 * ANSI E1.31 (sACN), receive side only.
 *
 * Three nested layers, all big-endian, and every one of them has to be checked
 * before the payload is worth anything: the port carries other ACN traffic,
 * and a packet that merely arrives on 5568 is not a packet that means what you
 * hope it means.
 *
 * ```
 *   0..1   Preamble size          0x0010
 *   2..3   Postamble size         0x0000
 *   4..15  ACN packet identifier  "ASC-E1.17\0\0\0"
 *  16..17  Root flags & length
 *  18..21  Root vector            0x00000004
 *  22..37  CID (16 bytes)
 *  38..39  Framing flags & length
 *  40..43  Framing vector         0x00000002
 *  44..107 Source name            64 bytes, UTF-8, null-terminated
 * 108      Priority               0–200
 * 109..110 Synchronization address
 * 111      Sequence number
 * 112      Options
 * 113..114 Universe               1–63999
 * 115..116 DMP flags & length
 * 117      DMP vector             0x02
 * 118      Address & data type    0xa1
 * 119..120 First property address 0x0000
 * 121..122 Address increment      0x0001
 * 123..124 Property value count   1 + slots
 * 125      START code             0x00 for DMX
 * 126..    Slots, up to 512
 * ```
 */

const ACN_PID = Buffer.from('ASC-E1.17\0\0\0', 'latin1')

const VECTOR_ROOT_DATA = 0x00000004
const VECTOR_FRAMING_DATA = 0x00000002
const VECTOR_DMP_SET_PROPERTY = 0x02

/**
 * The other root vector, and the framing vector under it that means "this is
 * a synchronization packet" (E1.31 Appendix A).
 *
 * `VECTOR_E131_EXTENDED_SYNCHRONIZATION` is 0x01 and
 * `VECTOR_E131_EXTENDED_DISCOVERY` is 0x02 — note that discovery's value is
 * the same number as `VECTOR_FRAMING_DATA` above, which is only unambiguous
 * because the *root* vector differs. Reading the framing vector without
 * having checked the root one first would take a discovery packet for data.
 */
const VECTOR_ROOT_EXTENDED = 0x00000008
const VECTOR_EXTENDED_SYNCHRONIZATION = 0x00000001

/**
 * The DMP layer's addressing, which E1.31 fixes to exactly one shape.
 *
 * A DMX data packet always addresses one contiguous run of one-byte
 * properties starting at zero. These three constants are what say so, and
 * checking them is what stops other DMP traffic on the same port from being
 * read as levels at offsets that only make sense for this one layout.
 *
 * Both reference implementations cross-checked against (libe131 and the
 * Hundemeier Python sACN library) treat all three as hard validation errors.
 */
const DMP_ADDRESS_DATA_TYPE = 0xa1
const DMP_FIRST_PROPERTY_ADDRESS = 0x0000
const DMP_ADDRESS_INCREMENT = 0x0001

/** DMX levels. Other start codes exist (RDM, text) and are not ours. */
const START_CODE_DMX = 0x00

/** Everything up to and including the START code. */
const HEADER = 126

/**
 * Options bits, numbered from the most significant end (E1.31 §6.2.6).
 *
 * These two were wrong in the first draft of the design — recorded as bits 6
 * and 5 — and a parser built on that reads every live packet as a preview,
 * discards it, and reports a rig that is running as silent. Since confirmed
 * against two independent implementations and then against the standard
 * itself, which is why the tests pin them explicitly.
 */
const OPTION_PREVIEW_DATA = 0x80
const OPTION_STREAM_TERMINATED = 0x40
const OPTION_FORCE_SYNCHRONIZATION = 0x20

/**
 * How far behind the last sequence number a packet may be before it is taken
 * as a straggler rather than as the next frame.
 *
 * E1.31 §6.7.2 states it as: with A the last sequence number and B the new
 * one, discard when B − A in signed 8-bit arithmetic is ≤ 0 and > −20. The
 * window is deliberately generous so a source resetting its counter is
 * followed immediately rather than ignored for 20 frames.
 */
export const SEQUENCE_DISCARD_WINDOW = 20

/** Parse one datagram, or null if it isn't an E1.31 DMX data packet. */
export function parseSacn(buf: Buffer): DmxFrame | null {
  // HEADER is the shortest legal packet: a universe with no slots in it.
  if (buf.length < HEADER) return null
  if (buf.readUInt16BE(0) !== 0x0010) return null
  if (buf.readUInt16BE(2) !== 0x0000) return null
  if (!buf.subarray(4, 16).equals(ACN_PID)) return null
  if (buf.readUInt32BE(18) !== VECTOR_ROOT_DATA) return null
  if (buf.readUInt32BE(40) !== VECTOR_FRAMING_DATA) return null
  if (buf[117] !== VECTOR_DMP_SET_PROPERTY) return null
  if (buf[118] !== DMP_ADDRESS_DATA_TYPE) return null
  if (buf.readUInt16BE(119) !== DMP_FIRST_PROPERTY_ADDRESS) return null
  if (buf.readUInt16BE(121) !== DMP_ADDRESS_INCREMENT) return null
  if (buf[125] !== START_CODE_DMX) return null

  const universe = buf.readUInt16BE(113)
  if (universe < 1 || universe > 63999) return null

  // The count includes the START code, so the slots are one fewer. Trust the
  // datagram's real length over the declared count — a truncated packet is
  // commoner than a short one, and reading past the end would be worse than
  // either.
  const declared = buf.readUInt16BE(123)
  const available = buf.length - HEADER
  const length = Math.max(0, Math.min(declared - 1, available, UNIVERSE_SIZE))

  const nameRaw = buf.subarray(44, 108)
  const nameEnd = nameRaw.indexOf(0)
  const options = buf[112]!

  return {
    protocol: 'sacn',
    wireUniverse: universe,
    // The CID identifies the source across IP changes and behind NAT, which
    // an address cannot.
    sourceId: buf.subarray(22, 38).toString('hex'),
    sourceName: nameRaw.toString('utf8', 0, nameEnd === -1 ? nameRaw.length : nameEnd).trim(),
    // Capped rather than rejected. 200 is the ceiling a legal source may
    // claim, and letting a malformed 255 through would hand a misbehaving
    // sender the universe over a console correctly asking for 200 — while
    // dropping the packet outright would lose a whole rig over one byte.
    priority: Math.min(buf[108]!, MAX_PRIORITY),
    sequence: buf[111]!,
    sequenced: true,
    // Non-zero means a conforming receiver holds this packet until the
    // matching synchronization packet arrives (§6.2.4), so what is on the
    // wire is not yet what is on stage.
    syncAddress: buf.readUInt16BE(109),
    forceSync: (options & OPTION_FORCE_SYNCHRONIZATION) !== 0,
    slots: new Uint8Array(buf.subarray(HEADER, HEADER + length)),
    preview: (options & OPTION_PREVIEW_DATA) !== 0,
    terminated: (options & OPTION_STREAM_TERMINATED) !== 0,
  }
}

/** A source telling receivers to act on what they are holding. */
export interface SacnSync {
  /** The universe this synchronises. Never 0 — §6.3.3.1 forbids it. */
  syncAddress: number
  /** The sending CID, hex, same identity a data packet carries. */
  sourceId: string
  sequence: number
}

/**
 * Parse an E1.31 Synchronization Packet, or null if it isn't one.
 *
 * A separate function rather than another arm of `parseSacn` because the two
 * share only the root layer: there is no DMP layer here at all, no priority,
 * no options, no slots, and the framing layer is nine octets long.
 *
 * ```
 *  0..37   Root layer, as above, but vector 0x00000008
 *  38..39  Framing flags & length
 *  40..43  Framing vector         0x00000001
 * 44       Sequence number
 * 45..46   Synchronization address
 * 47..48   Reserved — transmitted as 0, ignored here (§6.3.4)
 * ```
 *
 * Worth reading at all because of §6.2.4.1: data carrying a synchronization
 * address is only *held* by a receiver that is seeing this stream. Without
 * parsing these, crewbox could not tell a rig waiting on a cue from a rig
 * frozen because the sync stream died.
 */
export function parseSacnSync(buf: Buffer): SacnSync | null {
  // 47 for everything up to the address; the two reserved octets after it are
  // not worth rejecting a packet over.
  if (buf.length < 47) return null
  if (buf.readUInt16BE(0) !== 0x0010) return null
  if (buf.readUInt16BE(2) !== 0x0000) return null
  if (!buf.subarray(4, 16).equals(ACN_PID)) return null
  if (buf.readUInt32BE(18) !== VECTOR_ROOT_EXTENDED) return null
  if (buf.readUInt32BE(40) !== VECTOR_EXTENDED_SYNCHRONIZATION) return null

  // "A Synchronization Address of 0 is thus meaningless, and shall not be
  // transmitted. Receivers shall ignore E1.31 Synchronization Packets
  // containing a Synchronization Address of 0." (§6.3.3.1)
  const syncAddress = buf.readUInt16BE(45)
  if (syncAddress < 1 || syncAddress > 63999) return null

  return {
    syncAddress,
    sourceId: buf.subarray(22, 38).toString('hex'),
    sequence: buf[44]!,
  }
}
