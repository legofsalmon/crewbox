import { describe, expect, it } from 'vitest'
import {
  TYPE_A,
  TYPE_AAAA,
  TYPE_ANY,
  TYPE_NSEC,
  TYPE_PTR,
  TYPE_SRV,
  TYPE_TXT,
  decodeMessage,
  encodeData,
  encodeMessage,
  sameName,
  truncateUtf8,
  type ResourceRecord,
} from '../src/announce/dns.ts'

/**
 * The announcer's DNS codec. What matters: what it writes is what RFC 1035
 * and RFC 6762 say, byte for byte where a phone would notice, and what it
 * reads never throws and never half-believes a broken packet.
 */

const record = (over: Partial<ResourceRecord> & Pick<ResourceRecord, 'data'>): ResourceRecord => ({
  name: ['box', 'local'],
  type: TYPE_A,
  cacheFlush: false,
  ttl: 120,
  ...over,
})

describe('writing', () => {
  it('writes a response header that says authoritative answer and nothing else', () => {
    const buf = encodeMessage({
      id: 0,
      response: true,
      questions: [],
      answers: [record({ data: { kind: 'a', address: '10.0.0.2' } })],
      authorities: [],
      additionals: [],
    })
    expect(buf.readUInt16BE(0)).toBe(0)
    expect(buf.readUInt16BE(2)).toBe(0x8400)
    expect([
      buf.readUInt16BE(4),
      buf.readUInt16BE(6),
      buf.readUInt16BE(8),
      buf.readUInt16BE(10),
    ]).toEqual([0, 1, 0, 0])
  })

  it('writes an A record the way RFC 1035 lays it out, with the cache-flush bit on the class', () => {
    const buf = encodeMessage({
      id: 0,
      response: true,
      questions: [],
      answers: [record({ cacheFlush: true, data: { kind: 'a', address: '10.0.0.2' } })],
      authorities: [],
      additionals: [],
    })
    expect(buf.subarray(12).toString('hex')).toBe(
      // 3 "box" 5 "local" 0, type A, class IN|flush, ttl 120, length 4, 10.0.0.2
      '03626f78056c6f63616c00' + '0001' + '8001' + '00000078' + '0004' + '0a000002'
    )
  })

  it('writes the question class with the unicast-response bit when asked for one', () => {
    const buf = encodeMessage({
      id: 0,
      response: false,
      questions: [{ name: ['_crewbox', '_tcp', 'local'], type: TYPE_PTR, unicast: true }],
      answers: [],
      authorities: [],
      additionals: [],
    })
    expect(buf.readUInt16BE(2)).toBe(0)
    expect(buf.subarray(buf.length - 4).toString('hex')).toBe('000c8001')
  })

  it('writes an empty TXT record as one empty string, never as nothing', () => {
    expect(encodeData({ kind: 'txt', strings: [] }).toString('hex')).toBe('00')
  })

  it('writes an NSEC bitmap in window 0 only, as RFC 6762 restricts it', () => {
    // A (1) and TXT (16) and SRV (33): bits 1, 16 and 33, so five bytes.
    const data = encodeData({
      kind: 'nsec',
      next: ['x', 'local'],
      types: [TYPE_TXT, TYPE_SRV, TYPE_A],
    })
    expect(data.subarray(data.length - 7).toString('hex')).toBe(
      '0005' + '40' + '00' + '80' + '00' + '40'
    )
  })

  it('keeps a dot inside a label as part of the label', () => {
    const data = encodeData({
      kind: 'ptr',
      target: ['Main stage. Day 2', '_crewbox', '_tcp', 'local'],
    })
    expect(data[0]).toBe(17)
    expect(data.subarray(1, 18).toString('utf8')).toBe('Main stage. Day 2')
  })

  it('refuses a label longer than 63 bytes rather than writing a broken name', () => {
    expect(() => encodeData({ kind: 'ptr', target: ['x'.repeat(64), 'local'] })).toThrow(RangeError)
  })
})

describe('reading', () => {
  it('reads back everything it writes', () => {
    const message = {
      id: 7,
      response: true,
      questions: [{ name: ['_crewbox', '_tcp', 'local'], type: TYPE_PTR, unicast: false }],
      answers: [
        record({
          name: ['_crewbox', '_tcp', 'local'],
          type: TYPE_PTR,
          ttl: 4500,
          data: { kind: 'ptr', target: ['Fest', '_crewbox', '_tcp', 'local'] },
        }),
      ],
      authorities: [],
      additionals: [
        record({
          name: ['Fest', '_crewbox', '_tcp', 'local'],
          type: TYPE_SRV,
          cacheFlush: true,
          data: {
            kind: 'srv',
            priority: 0,
            weight: 0,
            port: 8787,
            target: ['crewbox-abc123', 'local'],
          },
        }),
        record({
          name: ['Fest', '_crewbox', '_tcp', 'local'],
          type: TYPE_TXT,
          cacheFlush: true,
          ttl: 4500,
          data: { kind: 'txt', strings: [Buffer.from('txtvers=1'), Buffer.from('name=Fest')] },
        }),
        record({ cacheFlush: true, data: { kind: 'a', address: '192.168.1.20' } }),
        record({
          type: TYPE_NSEC,
          cacheFlush: true,
          data: { kind: 'nsec', next: ['box', 'local'], types: [TYPE_A] },
        }),
      ],
    }
    const decoded = decodeMessage(encodeMessage(message))
    expect(decoded).toEqual({ ...message, truncated: false })
  })

  it('follows compression pointers, which is how phones write their questions', () => {
    // Two questions, the second's "_tcp.local" a pointer back into the first.
    const buf = Buffer.from(
      '000000000002000000000000' +
        '085f63726577626f78045f746370056c6f63616c00' +
        '000c0001' +
        '045f73736bc015' +
        '000c8001',
      'hex'
    )
    const decoded = decodeMessage(buf)
    expect(decoded?.questions).toEqual([
      { name: ['_crewbox', '_tcp', 'local'], type: TYPE_PTR, unicast: false },
      { name: ['_ssk', '_tcp', 'local'], type: TYPE_PTR, unicast: true },
    ])
  })

  it('drops a packet whose pointer loops rather than following it forever', () => {
    const buf = Buffer.from('000000000001000000000000' + 'c00c' + '000c0001', 'hex')
    expect(decodeMessage(buf)).toBeNull()
  })

  it('drops a packet that claims more entries than it could hold', () => {
    const buf = Buffer.from('00000000ffff000000000000', 'hex')
    expect(decodeMessage(buf)).toBeNull()
  })

  it('drops a packet that ends in the middle of a record', () => {
    const whole = encodeMessage({
      id: 0,
      response: true,
      questions: [],
      answers: [record({ data: { kind: 'a', address: '10.0.0.2' } })],
      authorities: [],
      additionals: [],
    })
    expect(decodeMessage(whole.subarray(0, whole.length - 2))).toBeNull()
  })

  it('ignores anything that is not a standard query: another opcode, or an error', () => {
    const buf = Buffer.alloc(12)
    buf.writeUInt16BE(0x2800, 2) // opcode 5, an update
    expect(decodeMessage(buf)).toBeNull()
    buf.writeUInt16BE(0x8403, 2) // NXDOMAIN
    expect(decodeMessage(buf)).toBeNull()
  })

  it('notices the truncated bit, which says more known answers follow', () => {
    const buf = Buffer.alloc(12)
    buf.writeUInt16BE(0x0200, 2)
    expect(decodeMessage(buf)?.truncated).toBe(true)
  })

  it('keeps a record type it does not know as its bytes', () => {
    const buf = encodeMessage({
      id: 0,
      response: true,
      questions: [],
      answers: [record({ type: TYPE_AAAA, data: { kind: 'raw', bytes: Buffer.alloc(16, 1) } })],
      authorities: [],
      additionals: [],
    })
    expect(decodeMessage(buf)?.answers[0]?.data).toEqual({
      kind: 'raw',
      bytes: Buffer.alloc(16, 1),
    })
  })

  it('never throws on junk', () => {
    for (let seed = 0; seed < 500; seed++) {
      const junk = Buffer.alloc(12 + (seed % 60))
      for (let i = 0; i < junk.length; i++) junk[i] = (seed * 31 + i * 17) & 0xff
      expect(() => decodeMessage(junk)).not.toThrow()
    }
  })

  it('reads an ANY question', () => {
    const buf = encodeMessage({
      id: 0,
      response: false,
      questions: [{ name: ['box', 'local'], type: TYPE_ANY, unicast: false }],
      answers: [],
      authorities: [],
      additionals: [],
    })
    expect(decodeMessage(buf)?.questions[0]?.type).toBe(TYPE_ANY)
  })
})

describe('names', () => {
  it('compares ASCII without regard to case, and nothing else', () => {
    expect(sameName(['Crewbox-ABC', 'local'], ['crewbox-abc', 'LOCAL'])).toBe(true)
    expect(sameName(['Fête', 'local'], ['FÊTE', 'local'])).toBe(false)
    expect(sameName(['a', 'b'], ['a'])).toBe(false)
  })

  it('cuts text to a byte count without splitting a character', () => {
    // "ê" is two bytes.
    expect(truncateUtf8('Fête', 2)).toBe('F')
    expect(truncateUtf8('Fête', 3)).toBe('Fê')
    expect(truncateUtf8('Fête', 4)).toBe('Fêt')
    expect(truncateUtf8('short', 63)).toBe('short')
  })
})
