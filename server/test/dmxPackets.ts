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
  startCode?: number
  rootVector?: number
  framingVector?: number
  dmpVector?: number
  preamble?: number
  acnId?: string
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
  buf.writeUInt16BE(0, 109)
  buf[111] = options.sequence ?? 1
  buf[112] = (options.preview ? 0x80 : 0) | (options.terminated ? 0x40 : 0)
  buf.writeUInt16BE(options.universe ?? 1, 113)
  buf.writeUInt16BE(0x7000 | (buf.length - 115), 115)
  buf[117] = options.dmpVector ?? 0x02
  buf[118] = 0xa1
  buf.writeUInt16BE(0x0000, 119)
  buf.writeUInt16BE(0x0001, 121)
  buf.writeUInt16BE(options.declaredCount ?? slots.length + 1, 123)
  buf[125] = options.startCode ?? 0x00
  for (let i = 0; i < slots.length; i++) buf[126 + i] = slots[i]!
  return buf
}

/** A full 512-slot payload with `lit` set at the given 1-based addresses. */
export function slotsWithLevels(lit: Record<number, number>): number[] {
  const slots = new Array<number>(UNIVERSE_SIZE).fill(0)
  for (const [address, level] of Object.entries(lit)) slots[Number(address) - 1] = level
  return slots
}
