/**
 * Packet builders for the tests.
 *
 * **These bytes are synthesised from the published specs, not captured from a
 * rig.** They and the parsers were written from the same reading, so a test
 * passing here means the two are consistent with each other — not that either
 * is right about the wire.
 *
 * That is a real limitation and it has already bitten once: the first draft of
 * the design had sACN's preview and terminated bits one place too low, and a
 * suite built on it would have been entirely green while discarding every live
 * packet as a console preview.
 *
 * `scripts/dmx-sniff.mjs --dump` exists to end this. When captures from a real
 * console land in `server/test/fixtures/dmx/`, the tests that matter should
 * read those, and these builders should be left only for the cases a capture
 * cannot easily produce — truncation, bad vectors, deliberate junk.
 */

import { UNIVERSE_SIZE } from '../src/dmx/types.ts'

export interface ArtDmxOptions {
  universe?: number
  sequence?: number
  protVer?: number
  slots?: number[]
  /** Override the declared length, to test disagreement with the real length. */
  declaredLength?: number
  opcode?: number
  id?: string
}

/** An ArtDmx packet. Mixed endianness is the point: LE opcode, BE length. */
export function artDmx(options: ArtDmxOptions = {}): Buffer {
  const slots = options.slots ?? [255, 128, 0, 64]
  const buf = Buffer.alloc(18 + slots.length)
  Buffer.from(options.id ?? 'Art-Net\0', 'latin1').copy(buf, 0)
  buf.writeUInt16LE(options.opcode ?? 0x5000, 8)
  buf.writeUInt16BE(options.protVer ?? 14, 10)
  buf[12] = options.sequence ?? 1
  buf[13] = 0
  const universe = options.universe ?? 0
  buf[14] = universe & 0xff
  buf[15] = (universe >> 8) & 0x7f
  buf.writeUInt16BE(options.declaredLength ?? slots.length, 16)
  for (let i = 0; i < slots.length; i++) buf[18 + i] = slots[i]!
  return buf
}

/**
 * An ArtSync packet. Eight bytes of identifier, the opcode, and the version —
 * there is no payload and no port address, which is the whole reason a node's
 * sync state is one timer for the network rather than per universe.
 */
export function artSync(): Buffer {
  const buf = Buffer.alloc(14)
  Buffer.from('Art-Net\0', 'latin1').copy(buf, 0)
  buf.writeUInt16LE(0x5200, 8)
  buf.writeUInt16BE(14, 10)
  return buf
}

export function artPollReply(ip: string, shortName: string, longName: string): Buffer {
  const buf = Buffer.alloc(240)
  Buffer.from('Art-Net\0', 'latin1').copy(buf, 0)
  buf.writeUInt16LE(0x2100, 8)
  for (let i = 0; i < 4; i++) buf[10 + i] = Number(ip.split('.')[i] ?? 0)
  Buffer.from(shortName, 'latin1').copy(buf, 26)
  Buffer.from(longName, 'latin1').copy(buf, 44)
  return buf
}

export interface SacnOptions {
  universe?: number
  sequence?: number
  priority?: number
  sourceName?: string
  cid?: string
  slots?: number[]
  preview?: boolean
  terminated?: boolean
  forceSync?: boolean
  syncAddress?: number
  startCode?: number
  rootVector?: number
  framingVector?: number
  dmpVector?: number
  preamble?: number
  acnId?: string
  /** DMP addressing, which E1.31 fixes — overridable so rejection is testable. */
  addressType?: number
  firstAddress?: number
  addressIncrement?: number
  /** Override the declared property value count (which includes the start code). */
  declaredCount?: number
}

/** An E1.31 data packet. All big-endian, three layers of preamble. */
export function sacnData(options: SacnOptions = {}): Buffer {
  const slots = options.slots ?? [255, 128, 0, 64]
  const buf = Buffer.alloc(126 + slots.length)
  buf.writeUInt16BE(options.preamble ?? 0x0010, 0)
  buf.writeUInt16BE(0x0000, 2)
  Buffer.from(options.acnId ?? 'ASC-E1.17\0\0\0', 'latin1').copy(buf, 4)
  buf.writeUInt16BE(0x7000 | (buf.length - 16), 16)
  buf.writeUInt32BE(options.rootVector ?? 0x00000004, 18)
  Buffer.from((options.cid ?? '0123456789abcdef').padEnd(16, '\0'), 'latin1').copy(buf, 22)
  buf.writeUInt16BE(0x7000 | (buf.length - 38), 38)
  buf.writeUInt32BE(options.framingVector ?? 0x00000002, 40)
  Buffer.from(options.sourceName ?? 'Test Console', 'utf8').copy(buf, 44)
  buf[108] = options.priority ?? 100
  buf.writeUInt16BE(options.syncAddress ?? 0, 109)
  buf[111] = options.sequence ?? 1
  buf[112] =
    (options.preview ? 0x80 : 0) | (options.terminated ? 0x40 : 0) | (options.forceSync ? 0x20 : 0)
  buf.writeUInt16BE(options.universe ?? 1, 113)
  buf.writeUInt16BE(0x7000 | (buf.length - 115), 115)
  buf[117] = options.dmpVector ?? 0x02
  buf[118] = options.addressType ?? 0xa1
  buf.writeUInt16BE(options.firstAddress ?? 0x0000, 119)
  buf.writeUInt16BE(options.addressIncrement ?? 0x0001, 121)
  buf.writeUInt16BE(options.declaredCount ?? slots.length + 1, 123)
  buf[125] = options.startCode ?? 0x00
  for (let i = 0; i < slots.length; i++) buf[126 + i] = slots[i]!
  return buf
}

export interface SacnSyncOptions {
  syncAddress?: number
  sequence?: number
  cid?: string
  rootVector?: number
  framingVector?: number
  acnId?: string
}

/**
 * An E1.31 Synchronization Packet (Table 4-2). 49 octets, no DMP layer.
 *
 * Note the root vector: `VECTOR_ROOT_E131_EXTENDED` (0x08), not the data
 * packet's 0x04. The framing vector under it is 0x01 — which is *not* the
 * data packet's 0x02, but is a value discovery packets also use under a
 * different root, so the two vectors only disambiguate as a pair.
 */
export function sacnSync(options: SacnSyncOptions = {}): Buffer {
  const buf = Buffer.alloc(49)
  buf.writeUInt16BE(0x0010, 0)
  buf.writeUInt16BE(0x0000, 2)
  Buffer.from(options.acnId ?? 'ASC-E1.17\0\0\0', 'latin1').copy(buf, 4)
  buf.writeUInt16BE(0x7000 | (buf.length - 16), 16)
  buf.writeUInt32BE(options.rootVector ?? 0x00000008, 18)
  Buffer.from((options.cid ?? '0123456789abcdef').padEnd(16, '\0'), 'latin1').copy(buf, 22)
  buf.writeUInt16BE(0x7000 | (buf.length - 38), 38)
  buf.writeUInt32BE(options.framingVector ?? 0x00000001, 40)
  buf[44] = options.sequence ?? 1
  buf.writeUInt16BE(options.syncAddress ?? 7962, 45)
  // 47-48 reserved, transmitted as 0 (§6.3.4). Already zero from alloc.
  return buf
}

/** A full 512-slot payload with `lit` set at the given 1-based addresses. */
export function slotsWithLevels(lit: Record<number, number>): number[] {
  const slots = new Array<number>(UNIVERSE_SIZE).fill(0)
  for (const [address, level] of Object.entries(lit)) slots[Number(address) - 1] = level
  return slots
}

export interface SacnDiscoveryOptions {
  universes?: number[]
  page?: number
  lastPage?: number
  sourceName?: string
  cid?: string
  rootVector?: number
  framingVector?: number
  discoveryVector?: number
  acnId?: string
  /** Pad the list with trailing zeroes, which some senders do. */
  padTo?: number
}

/**
 * An E1.31 Universe Discovery Packet (Table 4-3). No DMP layer; a Universe
 * Discovery layer starting at octet 112 instead.
 *
 * Note that this shares its *framing* vector value (0x02) with a data packet
 * and its *discovery* vector value (0x01) with a synchronization packet's
 * framing vector. Only the combination with the root vector separates them.
 */
export function sacnDiscovery(options: SacnDiscoveryOptions = {}): Buffer {
  const universes = options.universes ?? [1, 2, 3]
  const count = Math.max(universes.length, options.padTo ?? 0)
  const buf = Buffer.alloc(120 + count * 2)
  buf.writeUInt16BE(0x0010, 0)
  buf.writeUInt16BE(0x0000, 2)
  Buffer.from(options.acnId ?? 'ASC-E1.17\0\0\0', 'latin1').copy(buf, 4)
  buf.writeUInt16BE(0x7000 | (buf.length - 16), 16)
  buf.writeUInt32BE(options.rootVector ?? 0x00000008, 18)
  Buffer.from((options.cid ?? '0123456789abcdef').padEnd(16, '\0'), 'latin1').copy(buf, 22)
  buf.writeUInt16BE(0x7000 | (buf.length - 38), 38)
  buf.writeUInt32BE(options.framingVector ?? 0x00000002, 40)
  Buffer.from(options.sourceName ?? 'Test Console', 'utf8').copy(buf, 44)
  // 108-111 reserved, transmitted as 0 (§6.4.3).
  buf.writeUInt16BE(0x7000 | (buf.length - 112), 112)
  buf.writeUInt32BE(options.discoveryVector ?? 0x00000001, 114)
  buf[118] = options.page ?? 0
  buf[119] = options.lastPage ?? 0
  universes.forEach((universe, i) => buf.writeUInt16BE(universe, 120 + i * 2))
  return buf
}
