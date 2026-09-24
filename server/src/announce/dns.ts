/**
 * The DNS message format, as much of it as the box's Bonjour announcer needs
 * (RFC 1035 §4, with the multicast DNS changes of RFC 6762 §18).
 *
 * The watchers' parser (netwatch/mdns.ts) reads answers and nothing else, and
 * stays that way: it belongs to code that never sends. This one reads
 * questions as well, and writes whole messages, because the announcer has to
 * answer phones.
 *
 * Names are kept as their labels, not as dotted strings. A DNS-SD instance
 * name is free text ("Festival 2026. Main stage") and a dot inside a label is
 * part of the label, so joining and splitting on dots would change the name.
 *
 * Reading never throws: junk on port 5353 is a certainty, and a message that
 * cannot be read is dropped whole rather than half-believed.
 */

export const TYPE_A = 1
export const TYPE_PTR = 12
export const TYPE_TXT = 16
export const TYPE_AAAA = 28
export const TYPE_SRV = 33
export const TYPE_NSEC = 47
export const TYPE_ANY = 255

export const CLASS_IN = 1

/** A DNS name, one string per label. */
export type Name = readonly string[]

export interface Question {
  name: Name
  type: number
  /** The top bit of the class: the asker would take a unicast answer (RFC 6762 §5.4). */
  unicast: boolean
}

export type RecordData =
  | { kind: 'a'; address: string }
  | { kind: 'ptr'; target: Name }
  | { kind: 'txt'; strings: Buffer[] }
  | { kind: 'srv'; priority: number; weight: number; port: number; target: Name }
  | { kind: 'nsec'; next: Name; types: number[] }
  /** Any other type, as its bytes. Compressed names inside it are not expanded. */
  | { kind: 'raw'; bytes: Buffer }

export interface ResourceRecord {
  name: Name
  type: number
  /** The top bit of the class: this is the whole set, so flush the rest (RFC 6762 §10.2). */
  cacheFlush: boolean
  ttl: number
  data: RecordData
}

export interface Message {
  id: number
  /** QR: a response rather than a query. */
  response: boolean
  /** TC: more known answers follow in another packet (RFC 6762 §7.2). */
  truncated: boolean
  questions: Question[]
  answers: ResourceRecord[]
  authorities: ResourceRecord[]
  additionals: ResourceRecord[]
}

/**
 * Compare two names the way multicast DNS does: ASCII letters without regard
 * to case, every other byte exactly (RFC 6762 §16).
 */
export function sameName(a: Name, b: Name): boolean {
  if (a.length !== b.length) return false
  return a.every((label, i) => foldCase(label) === foldCase(b[i] ?? ''))
}

const foldCase = (label: string): string => label.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** A label's length on the wire. */
export const labelBytes = (label: string): number => Buffer.byteLength(label, 'utf8')

/**
 * Cut text to at most `max` bytes of UTF-8 without splitting a character, so
 * a long event name fits a label (63) or a TXT string (255).
 */
export function truncateUtf8(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > max) break
    out += char
    used += size
  }
  return out
}

// ---------------------------------------------------------------------------
// Writing

function encodeName(name: Name): Buffer {
  const parts: Buffer[] = []
  for (const label of name) {
    const bytes = Buffer.from(label, 'utf8')
    if (bytes.length === 0 || bytes.length > 63) {
      throw new RangeError(`a DNS label must be 1 to 63 bytes, not ${bytes.length}`)
    }
    parts.push(Buffer.from([bytes.length]), bytes)
  }
  parts.push(Buffer.from([0]))
  const out = Buffer.concat(parts)
  if (out.length > 255) throw new RangeError('a DNS name must be at most 255 bytes')
  return out
}

/** The type bitmap of an NSEC record: window 0 only, as RFC 6762 §6.1 restricts it. */
function typeBitmap(types: number[]): Buffer {
  const wanted = [...new Set(types)].filter((t) => t > 0 && t < 256)
  if (wanted.length === 0) return Buffer.alloc(0)
  const length = (Math.max(...wanted) >> 3) + 1
  const bitmap = Buffer.alloc(length)
  for (const t of wanted) bitmap[t >> 3]! |= 0x80 >> (t & 7)
  return Buffer.concat([Buffer.from([0, length]), bitmap])
}

/**
 * A record's data, uncompressed: the form written on the wire here, and the
 * form RFC 6762 §8.2 compares when two hosts probe for one name.
 */
export function encodeData(data: RecordData): Buffer {
  switch (data.kind) {
    case 'a': {
      const octets = data.address.split('.').map(Number)
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        throw new RangeError(`not an IPv4 address: ${data.address}`)
      }
      return Buffer.from(octets)
    }
    case 'ptr':
      return encodeName(data.target)
    case 'txt': {
      // An empty TXT record is one empty string, never no strings (RFC 6763 §6.1).
      const strings = data.strings.length ? data.strings : [Buffer.alloc(0)]
      return Buffer.concat(
        strings.flatMap((s) => {
          if (s.length > 255) throw new RangeError('a TXT string must be at most 255 bytes')
          return [Buffer.from([s.length]), s]
        })
      )
    }
    case 'srv': {
      const head = Buffer.alloc(6)
      head.writeUInt16BE(data.priority, 0)
      head.writeUInt16BE(data.weight, 2)
      head.writeUInt16BE(data.port, 4)
      return Buffer.concat([head, encodeName(data.target)])
    }
    case 'nsec':
      return Buffer.concat([encodeName(data.next), typeBitmap(data.types)])
    case 'raw':
      return data.bytes
  }
}

function encodeRecord(record: ResourceRecord): Buffer {
  const rdata = encodeData(record.data)
  const fixed = Buffer.alloc(10)
  fixed.writeUInt16BE(record.type, 0)
  fixed.writeUInt16BE(CLASS_IN | (record.cacheFlush ? 0x8000 : 0), 2)
  fixed.writeUInt32BE(record.ttl, 4)
  fixed.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([encodeName(record.name), fixed, rdata])
}

function encodeQuestion(question: Question): Buffer {
  const fixed = Buffer.alloc(4)
  fixed.writeUInt16BE(question.type, 0)
  fixed.writeUInt16BE(CLASS_IN | (question.unicast ? 0x8000 : 0), 2)
  return Buffer.concat([encodeName(question.name), fixed])
}

/**
 * A whole message. Names are never compressed: the announcer's packets are a
 * few hundred bytes, and uncompressed is what every reader accepts.
 */
export function encodeMessage(message: Omit<Message, 'truncated'>): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(message.id, 0)
  // A response is authoritative (RFC 6762 §18.4); a query has no flags set.
  header.writeUInt16BE(message.response ? 0x8400 : 0, 2)
  header.writeUInt16BE(message.questions.length, 4)
  header.writeUInt16BE(message.answers.length, 6)
  header.writeUInt16BE(message.authorities.length, 8)
  header.writeUInt16BE(message.additionals.length, 10)
  return Buffer.concat([
    header,
    ...message.questions.map(encodeQuestion),
    ...message.answers.map(encodeRecord),
    ...message.authorities.map(encodeRecord),
    ...message.additionals.map(encodeRecord),
  ])
}

// ---------------------------------------------------------------------------
// Reading

/**
 * A possibly compressed name at `offset`, and the offset after its in-place
 * bytes. Null for anything malformed: a pointer loop, a label running off the
 * end, or a name longer than DNS allows (RFC 1035 §3.1), which also bounds the
 * work one small packet can cause.
 */
function readName(buf: Buffer, offset: number): { name: string[]; next: number } | null {
  const labels: string[] = []
  let at = offset
  let next = -1
  let hops = 0
  let octets = 0
  while (true) {
    if (at >= buf.length) return null
    const len = buf[at]!
    if (len === 0) {
      if (next === -1) next = at + 1
      break
    }
    if ((len & 0xc0) === 0xc0) {
      if (at + 1 >= buf.length) return null
      if (next === -1) next = at + 2
      at = ((len & 0x3f) << 8) | buf[at + 1]!
      if (++hops > 16) return null
      continue
    }
    if ((len & 0xc0) !== 0) return null
    if (at + 1 + len > buf.length) return null
    octets += len + 1
    if (octets > 255) return null
    labels.push(buf.toString('utf8', at + 1, at + 1 + len))
    at += 1 + len
  }
  return { name: labels, next }
}

function readData(buf: Buffer, type: number, start: number, length: number): RecordData | null {
  const end = start + length
  switch (type) {
    case TYPE_A:
      if (length !== 4) return null
      return { kind: 'a', address: [...buf.subarray(start, end)].join('.') }
    case TYPE_PTR: {
      const target = readName(buf, start)
      return target ? { kind: 'ptr', target: target.name } : null
    }
    case TYPE_TXT: {
      const strings: Buffer[] = []
      let at = start
      while (at < end) {
        const len = buf[at]!
        if (at + 1 + len > end) return null
        strings.push(Buffer.from(buf.subarray(at + 1, at + 1 + len)))
        at += 1 + len
      }
      return { kind: 'txt', strings }
    }
    case TYPE_SRV: {
      if (length < 7) return null
      const target = readName(buf, start + 6)
      if (!target) return null
      return {
        kind: 'srv',
        priority: buf.readUInt16BE(start),
        weight: buf.readUInt16BE(start + 2),
        port: buf.readUInt16BE(start + 4),
        target: target.name,
      }
    }
    case TYPE_NSEC: {
      const next = readName(buf, start)
      if (!next || next.next > end) return null
      const types: number[] = []
      let at = next.next
      while (at + 2 <= end) {
        const windowBlock = buf[at]!
        const size = buf[at + 1]!
        if (size < 1 || size > 32 || at + 2 + size > end) return null
        for (let i = 0; i < size; i++) {
          const byte = buf[at + 2 + i]!
          for (let bit = 0; bit < 8; bit++) {
            if (byte & (0x80 >> bit)) types.push(windowBlock * 256 + i * 8 + bit)
          }
        }
        at += 2 + size
      }
      return { kind: 'nsec', next: next.name, types }
    }
    default:
      return { kind: 'raw', bytes: Buffer.from(buf.subarray(start, end)) }
  }
}

/** One message, or null if any part of it could not be read. */
export function decodeMessage(buf: Buffer): Message | null {
  if (buf.length < 12) return null
  const flags = buf.readUInt16BE(2)
  // Opcode must be 0 (a standard query) and rcode 0; anything else is not
  // multicast DNS and is ignored, as RFC 6762 §18.3 and §18.11 ask.
  if ((flags & 0x7800) !== 0 || (flags & 0x000f) !== 0) return null
  const counts = [
    buf.readUInt16BE(4),
    buf.readUInt16BE(6),
    buf.readUInt16BE(8),
    buf.readUInt16BE(10),
  ]
  // Every entry takes at least five bytes, so a count the packet cannot hold
  // is junk, not a reason to loop.
  if (counts.reduce((sum, n) => sum + n, 0) * 5 > buf.length) return null

  let at = 12
  const questions: Question[] = []
  for (let i = 0; i < counts[0]!; i++) {
    const name = readName(buf, at)
    if (!name || name.next + 4 > buf.length) return null
    const qclass = buf.readUInt16BE(name.next + 2)
    questions.push({
      name: name.name,
      type: buf.readUInt16BE(name.next),
      unicast: (qclass & 0x8000) !== 0,
    })
    at = name.next + 4
  }

  const sections: ResourceRecord[][] = [[], [], []]
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < counts[s + 1]!; i++) {
      const name = readName(buf, at)
      if (!name || name.next + 10 > buf.length) return null
      const type = buf.readUInt16BE(name.next)
      const rclass = buf.readUInt16BE(name.next + 2)
      const ttl = buf.readUInt32BE(name.next + 4)
      const length = buf.readUInt16BE(name.next + 8)
      const start = name.next + 10
      if (start + length > buf.length) return null
      const data = readData(buf, type, start, length)
      if (!data) return null
      sections[s]!.push({ name: name.name, type, cacheFlush: (rclass & 0x8000) !== 0, ttl, data })
      at = start + length
    }
  }

  return {
    id: buf.readUInt16BE(0),
    response: (flags & 0x8000) !== 0,
    truncated: (flags & 0x0200) !== 0,
    questions,
    answers: sections[0]!,
    authorities: sections[1]!,
    additionals: sections[2]!,
  }
}
