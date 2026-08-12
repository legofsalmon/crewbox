import { describe, expect, it } from 'vitest'
import {
  BerError,
  MAX_VALUE_LEN,
  TAG_INTEGER,
  TAG_OCTET_STRING,
  TAG_SEQUENCE,
  decodeInteger,
  decodeOid,
  encodeInteger,
  encodeLength,
  encodeOid,
  encodeTlv,
  readSequence,
  readTlv,
} from '../src/video/ber.ts'

/**
 * The ASN.1 layer under the SNMP reader.
 *
 * novasun's advice was to use a platform SNMP client rather than hand-roll
 * one; crewbox went the other way so that no SET encoder exists anywhere in
 * the box (see the header of `ber.ts`). That trade is only worth taking if
 * the codec is actually right, which is what this file is for — and the
 * hostile-input half matters as much as the round trips, because the address
 * being read is one a human typed and may not be a controller at all.
 */

describe('lengths', () => {
  it('uses the short form under 128', () => {
    expect([...encodeLength(0)]).toEqual([0x00])
    expect([...encodeLength(127)]).toEqual([0x7f])
  })

  it('uses the long form at 128 and above', () => {
    expect([...encodeLength(128)]).toEqual([0x81, 0x80])
    expect([...encodeLength(256)]).toEqual([0x82, 0x01, 0x00])
  })

  it('round-trips a long-form value', () => {
    const value = Buffer.alloc(300, 0x41)
    const tlv = readTlv(encodeTlv(TAG_OCTET_STRING, value), 0)
    expect(tlv.value.length).toBe(300)
  })
})

describe('integers', () => {
  it('round-trips positives', () => {
    for (const n of [0, 1, 127, 128, 255, 256, 65535, 2_000_000]) {
      const tlv = readTlv(encodeInteger(n), 0)
      expect(tlv.tag).toBe(TAG_INTEGER)
      expect(decodeInteger(tlv.value)).toBe(n)
    }
  })

  it('round-trips negatives, which a January load-in produces', () => {
    // A controller in the cold reports temperatures below zero. Read as
    // unsigned, -3 comes back as 253 and a freezing processor reads as a hot
    // one, which is the wrong way round for the only alarm this pane has.
    for (const n of [-1, -3, -128, -129, -32768]) {
      expect(decodeInteger(readTlv(encodeInteger(n), 0).value)).toBe(n)
    }
  })

  it('does not let a positive read as negative', () => {
    // 128 needs a leading zero byte or its top bit makes it -128.
    expect([...readTlv(encodeInteger(128), 0).value]).toEqual([0x00, 0x80])
  })

  it('refuses an integer wider than 8 bytes', () => {
    expect(() => decodeInteger(Buffer.alloc(9))).toThrow(BerError)
  })
})

describe('object identifiers', () => {
  it('packs the first two arcs into one byte', () => {
    // 1.3 -> 43 (0x2b), which is where every NovaStar OID starts.
    expect(readTlv(encodeOid('1.3'), 0).value[0]).toBe(0x2b)
  })

  it('round-trips the NovaStar enterprise arc', () => {
    const oid = '1.3.6.1.4.1.319.10.10.1.2'
    expect(decodeOid(readTlv(encodeOid(oid), 0).value)).toBe(oid)
  })

  it('round-trips arcs over 127, which need continuation bytes', () => {
    // 319 is NovaStar's enterprise number and is itself multi-byte, so this
    // is not a hypothetical case.
    for (const oid of ['1.3.6.1.4.1.319', '1.3.6.1.4.1.319.10.20.1.2.128.5', '2.999.1']) {
      expect(decodeOid(readTlv(encodeOid(oid), 0).value)).toBe(oid)
    }
  })

  it('rejects junk arcs rather than encoding something plausible', () => {
    expect(() => encodeOid('1.3.six')).toThrow(BerError)
    expect(() => encodeOid('1')).toThrow(BerError)
  })
})

describe('reading hostile input', () => {
  it('refuses a length that claims more than a datagram', () => {
    const buf = Buffer.from([TAG_OCTET_STRING, 0x84, 0xff, 0xff, 0xff, 0xff])
    expect(() => readTlv(buf, 0)).toThrow(BerError)
  })

  it('refuses a value longer than the cap before allocating', () => {
    const len = MAX_VALUE_LEN + 1
    const buf = Buffer.from([TAG_OCTET_STRING, 0x82, (len >> 8) & 0xff, len & 0xff])
    expect(() => readTlv(buf, 0)).toThrow(BerError)
  })

  it('refuses a truncated value rather than returning a short one', () => {
    expect(() => readTlv(Buffer.from([TAG_OCTET_STRING, 0x08, 0x01, 0x02]), 0)).toThrow(BerError)
  })

  it('refuses the indefinite length form, which SNMP never uses', () => {
    expect(() => readTlv(Buffer.from([TAG_SEQUENCE, 0x80]), 0)).toThrow(BerError)
  })

  it('walks a sequence of mixed elements', () => {
    const seq = encodeTlv(
      TAG_SEQUENCE,
      Buffer.concat([encodeInteger(1), encodeOid('1.3.6.1'), encodeInteger(-5)])
    )
    const parts = readSequence(readTlv(seq, 0).value)
    expect(parts).toHaveLength(3)
    expect(decodeInteger(parts[0].value)).toBe(1)
    expect(decodeOid(parts[1].value)).toBe('1.3.6.1')
    expect(decodeInteger(parts[2].value)).toBe(-5)
  })
})
