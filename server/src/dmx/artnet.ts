import { DEFAULT_PRIORITY, UNIVERSE_SIZE, type ArtPollReply, type DmxFrame } from './types.ts'

/**
 * Art-Net 4, receive side only.
 *
 * The endianness is mixed and it catches people out: the OpCode is
 * **little-endian**, the protocol version and the data length are
 * **big-endian**, and the universe is a little-endian pair that happens to
 * read as `(Net << 8) | SubUni`. All three are exercised by the tests.
 *
 * Layout, from the published spec (offsets into an ArtDmx packet):
 *
 * ```
 *  0..7   "Art-Net\0"
 *  8..9   OpCode, little-endian (0x5000 ArtDmx, 0x2100 ArtPollReply)
 * 10..11  ProtVer, big-endian, ≥ 14
 * 12      Sequence (0 = sequencing disabled)
 * 13      Physical
 * 14      SubUni  ─┐ together the 15-bit Port-Address,
 * 15      Net     ─┘ which is also readUInt16LE(14) & 0x7fff
 * 16..17  Length, big-endian, 2–512
 * 18..    Data
 * ```
 */

const ID = 'Art-Net\0'
const OP_DMX = 0x5000
const OP_POLL_REPLY = 0x2100

/** Header bytes before the DMX data begins. */
const DMX_HEADER = 18

/** The lowest protocol version this parser understands. */
const MIN_PROT_VER = 14

export type ArtNetPacket =
  { kind: 'dmx'; frame: DmxFrame } | { kind: 'pollReply'; reply: ArtPollReply }

/** A null-terminated fixed-width name field, or '' when it isn't there. */
function fixedString(buf: Buffer, start: number, length: number): string {
  if (buf.length < start + length) return ''
  const raw = buf.subarray(start, start + length)
  const end = raw.indexOf(0)
  return raw.toString('latin1', 0, end === -1 ? raw.length : end).trim()
}

/**
 * Parse one datagram. Returns null for anything that isn't an Art-Net packet
 * this cares about — other opcodes, truncation, junk on the port.
 *
 * `fromIp` becomes the source identity: ArtDmx carries nothing that identifies
 * its sender, unlike sACN's CID.
 */
export function parseArtNet(buf: Buffer, fromIp: string): ArtNetPacket | null {
  if (buf.length < 10) return null
  if (buf.toString('latin1', 0, 8) !== ID) return null

  const opcode = buf.readUInt16LE(8)

  if (opcode === OP_POLL_REPLY) {
    // Names are cosmetic — they only ever improve a label — so a short or
    // odd reply degrades to an empty name rather than being thrown away.
    return {
      kind: 'pollReply',
      reply: {
        ip: fromIp,
        shortName: fixedString(buf, 26, 18),
        longName: fixedString(buf, 44, 64),
      },
    }
  }

  if (opcode !== OP_DMX || buf.length < DMX_HEADER) return null
  if (buf.readUInt16BE(10) < MIN_PROT_VER) return null

  // The top bit of the Net field is reserved; masking it keeps a sender that
  // sets it from producing a universe 32768 apart from everyone else's.
  const wireUniverse = buf.readUInt16LE(14) & 0x7fff

  // The spec says the length is even and 2–512. Real senders are not always
  // tidy, and a truncated datagram is commoner still, so take what is
  // actually present rather than trusting the header.
  const declared = buf.readUInt16BE(16)
  const available = buf.length - DMX_HEADER
  const length = Math.max(0, Math.min(declared, available, UNIVERSE_SIZE))

  const sequence = buf[12]!
  return {
    kind: 'dmx',
    frame: {
      protocol: 'artnet',
      wireUniverse,
      sourceId: fromIp,
      sourceName: '',
      // Art-Net has no priority field at all. Treating every source as the
      // default means two Art-Net senders on one universe read as a conflict,
      // which is exactly what they are.
      priority: DEFAULT_PRIORITY,
      sequence,
      sequenced: sequence !== 0,
      slots: new Uint8Array(buf.subarray(DMX_HEADER, DMX_HEADER + length)),
      // Art-Net has no equivalent of either.
      preview: false,
      terminated: false,
    },
  }
}
