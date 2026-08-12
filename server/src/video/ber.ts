/**
 * Just enough BER to ask an SNMP agent a question.
 *
 * novasun ships the OID map but deliberately no SNMP client, on the grounds
 * that "a hand-rolled ASN.1 encoder would be a liability" and every platform
 * has a good one. That is the right call for a Python investigation tool and
 * the wrong one here, for two reasons specific to this box:
 *
 *  - **The library would bring a `set()` with it.** The whole point of this
 *    module is that crewbox cannot write to a processor. `encodePdu` accepts
 *    `GET_REQUEST` and `GET_NEXT_REQUEST` and there is no third case; the
 *    SetRequest tag (0xa3) appears nowhere in this codebase, and a test
 *    asserts that by reading the source. A dependency with a working setter
 *    one call away is a much weaker promise than a codec that cannot express
 *    the operation.
 *  - **The box ships as one binary.** crewbox already hand-parses Art-Net,
 *    sACN, PTP, mDNS and SAP for the same reason.
 *
 * The liability novasun is warning about is a *general* ASN.1 implementation.
 * This is one PDU shape out and one in. A decode bug here costs a missing
 * field on a pane, not a packet on a show network.
 *
 * Everything decoded is bounded and length-checked before allocation — the
 * mDNS decompression bug (T2-6) is the house lesson about parsing hostile
 * lengths, and an LED processor's IP is typed in by a human who may typo it
 * into something else entirely.
 */

export const TAG_INTEGER = 0x02
export const TAG_OCTET_STRING = 0x04
export const TAG_NULL = 0x05
export const TAG_OID = 0x06
export const TAG_SEQUENCE = 0x30

/** Application types SNMP adds. All read-only values; none of them are verbs. */
export const TAG_IP_ADDRESS = 0x40
export const TAG_COUNTER32 = 0x41
export const TAG_GAUGE32 = 0x42
export const TAG_TIMETICKS = 0x43
export const TAG_COUNTER64 = 0x46

/** "The agent has nothing at this OID" — a normal answer, not an error. */
export const TAG_NO_SUCH_OBJECT = 0x80
export const TAG_NO_SUCH_INSTANCE = 0x81
export const TAG_END_OF_MIB = 0x82

/**
 * Nothing longer than this is parsed.
 *
 * An SNMP response to a handful of GETs is a few hundred bytes. A megabyte
 * claiming to be one is either a broken agent or something that is not an
 * agent at all, and either way the answer is to stop reading.
 */
export const MAX_VALUE_LEN = 4096

export class BerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BerError'
  }
}

/** Length octets, definite form only. Indefinite length is not valid in SNMP. */
export function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len])
  const bytes: number[] = []
  let n = len
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

export function encodeTlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value])
}

/** Two's-complement, shortest form. Used for versions, request ids and zeroes. */
export function encodeInteger(value: number): Buffer {
  if (!Number.isSafeInteger(value)) throw new BerError('integer out of range')
  const bytes: number[] = []
  let n = value
  do {
    bytes.unshift(n & 0xff)
    n >>= 8
  } while (n !== 0 && n !== -1)
  // A positive number whose top bit is set would read as negative, and a
  // negative one whose top bit is clear would read as positive.
  if (value >= 0 && (bytes[0] & 0x80) !== 0) bytes.unshift(0x00)
  if (value < 0 && (bytes[0] & 0x80) === 0) bytes.unshift(0xff)
  return encodeTlv(TAG_INTEGER, Buffer.from(bytes))
}

export function encodeOctetString(value: string): Buffer {
  return encodeTlv(TAG_OCTET_STRING, Buffer.from(value, 'utf8'))
}

export function encodeNull(): Buffer {
  return encodeTlv(TAG_NULL, Buffer.alloc(0))
}

/** Base-128, high bit set on every byte but the last. */
function varint(value: number): number[] {
  if (value < 0x80) return [value]
  const chunk: number[] = []
  let n = value
  while (n > 0) {
    chunk.unshift((n & 0x7f) | (chunk.length === 0 ? 0 : 0x80))
    n = Math.floor(n / 128)
  }
  return chunk
}

/**
 * Dotted OID to BER.
 *
 * The first two arcs share one subidentifier (`40 * a + b`), which is why
 * "1.3" becomes 0x2b and every NovaStar OID starts there. That subidentifier
 * is a varint like any other rather than a single byte: when the first arc is
 * 2 the second is unbounded, so `2.999` needs two bytes. No NovaStar OID goes
 * near that, but a codec that silently mangles valid input is a worse thing
 * to own than one that handles the whole grammar.
 */
export function encodeOid(oid: string): Buffer {
  const arcs = oid.split('.').map((a) => {
    const n = Number(a)
    if (a.trim() === '' || !Number.isSafeInteger(n) || n < 0) {
      throw new BerError(`bad OID arc "${a}" in ${oid}`)
    }
    return n
  })
  if (arcs.length < 2) throw new BerError(`OID too short: ${oid}`)
  if (arcs[0] > 2) throw new BerError(`OID root must be 0, 1 or 2: ${oid}`)
  if (arcs[0] < 2 && arcs[1] > 39) throw new BerError(`second arc out of range: ${oid}`)
  const bytes = [...varint(arcs[0] * 40 + arcs[1])]
  for (const arc of arcs.slice(2)) bytes.push(...varint(arc))
  return encodeTlv(TAG_OID, Buffer.from(bytes))
}

export interface Tlv {
  tag: number
  value: Buffer
  /** Offset just past this element, for walking a sequence. */
  end: number
}

/** Read one TLV at `offset`. Throws rather than returning a half-read value. */
export function readTlv(buf: Buffer, offset: number): Tlv {
  if (offset + 2 > buf.length) throw new BerError('truncated header')
  const tag = buf[offset]
  let len = buf[offset + 1]
  let cursor = offset + 2
  if ((len & 0x80) !== 0) {
    const count = len & 0x7f
    // Long-form length with more than 4 octets means a value bigger than any
    // real SNMP datagram; reject before multiplying anything out.
    if (count === 0 || count > 4) throw new BerError('unsupported length form')
    if (cursor + count > buf.length) throw new BerError('truncated length')
    len = 0
    for (let i = 0; i < count; i++) len = len * 256 + buf[cursor + i]
    cursor += count
  }
  if (len > MAX_VALUE_LEN) throw new BerError(`value of ${len} bytes is not an SNMP response`)
  if (cursor + len > buf.length) throw new BerError('truncated value')
  return { tag, value: buf.subarray(cursor, cursor + len), end: cursor + len }
}

/** Every TLV in a constructed value, in order. */
export function readSequence(value: Buffer): Tlv[] {
  const out: Tlv[] = []
  let offset = 0
  while (offset < value.length) {
    const tlv = readTlv(value, offset)
    out.push(tlv)
    offset = tlv.end
  }
  return out
}

/**
 * Two's-complement integer.
 *
 * Negative values are decoded by magnitude rather than by shifting, because
 * a Counter64 does not fit in the 32 bits JavaScript's bitwise operators use
 * and `<<` would silently wrap it. Temperatures below zero are the reason
 * this handles negatives at all — a controller in a January load-in reports
 * them, and an unsigned reader would call -3°C a very hot processor.
 */
export function decodeInteger(value: Buffer): number {
  if (value.length === 0) return 0
  if (value.length > 8) throw new BerError('integer too wide')
  if ((value[0] & 0x80) === 0) {
    let n = 0
    for (const byte of value) n = n * 256 + byte
    return n
  }
  let magnitude = 0
  for (const byte of value) magnitude = magnitude * 256 + (byte ^ 0xff)
  return -(magnitude + 1)
}

export function decodeOid(value: Buffer): string {
  if (value.length === 0) return ''
  const subidentifiers: number[] = []
  let acc = 0
  for (const byte of value) {
    acc = acc * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) {
      subidentifiers.push(acc)
      acc = 0
    }
  }
  if (subidentifiers.length === 0) return ''
  // Undo the shared first subidentifier. Roots 0 and 1 are capped at 39
  // second arcs, which is what makes the split unambiguous; root 2 takes
  // everything above 79.
  const first = subidentifiers[0]
  const head = first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80]
  return [...head, ...subidentifiers.slice(1)].join('.')
}
