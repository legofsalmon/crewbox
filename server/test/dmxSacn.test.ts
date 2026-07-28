import { describe, expect, it } from 'vitest'
import { parseSacn } from '../src/dmx/sacn.ts'
import { sacnData } from './dmxPackets.ts'

// Packets here are synthesised, not captured off a rig — see dmxPackets.ts.

describe('sACN: what it accepts', () => {
  it('reads levels, source and priority off a well-formed packet', () => {
    const frame = parseSacn(sacnData({ sourceName: 'grandMA3', priority: 120 }))!
    expect(frame).not.toBeNull()
    expect(frame.protocol).toBe('sacn')
    expect([...frame.slots]).toEqual([255, 128, 0, 64])
    expect(frame.sourceName).toBe('grandMA3')
    expect(frame.priority).toBe(120)
    expect(frame.wireUniverse).toBe(1)
  })

  it('identifies a source by CID, not by where it came from', () => {
    // The whole point: a console that changes IP is the same console, and two
    // behind one NAT are not the same console.
    const a = parseSacn(sacnData({ cid: 'aaaaaaaaaaaaaaaa' }))!
    const b = parseSacn(sacnData({ cid: 'bbbbbbbbbbbbbbbb' }))!
    expect(a.sourceId).not.toBe(b.sourceId)
    expect(a.sourceId).toBe(Buffer.from('aaaaaaaaaaaaaaaa', 'latin1').toString('hex'))
  })

  it('reads a universe big-endian', () => {
    // 256 is 0x0100; byte-swapped it would read as 1, putting a whole
    // universe's fixtures on top of another universe's.
    expect(parseSacn(sacnData({ universe: 256 }))!.wireUniverse).toBe(256)
    expect(parseSacn(sacnData({ universe: 63999 }))!.wireUniverse).toBe(63999)
  })

  it('is always sequenced', () => {
    expect(parseSacn(sacnData({ sequence: 0 }))!.sequenced).toBe(true)
  })
})

describe('sACN: the options bits', () => {
  // These two were wrong in the first draft of the design — recorded as bits 6
  // and 5 rather than 7 and 6. A parser built on that reads every live packet
  // as a console preview, discards it, and reports a rig that is running as
  // silent. The masks are pinned here so that can't come back.
  it('reads preview off bit 7 (0x80)', () => {
    expect(parseSacn(sacnData({ preview: true }))!.preview).toBe(true)
    expect(parseSacn(sacnData({ preview: false }))!.preview).toBe(false)
  })

  it('reads terminated off bit 6 (0x40)', () => {
    expect(parseSacn(sacnData({ terminated: true }))!.terminated).toBe(true)
    expect(parseSacn(sacnData({ terminated: false }))!.terminated).toBe(false)
  })

  it('does not confuse the two', () => {
    const preview = parseSacn(sacnData({ preview: true }))!
    expect(preview.terminated).toBe(false)
    const terminated = parseSacn(sacnData({ terminated: true }))!
    expect(terminated.preview).toBe(false)
  })

  it('reads both when both are set', () => {
    const frame = parseSacn(sacnData({ preview: true, terminated: true }))!
    expect(frame.preview).toBe(true)
    expect(frame.terminated).toBe(true)
  })
})

describe('sACN: what it rejects', () => {
  it('ignores other traffic on the port', () => {
    expect(parseSacn(Buffer.alloc(700))).toBeNull()
    expect(parseSacn(Buffer.from('not acn at all'))).toBeNull()
  })

  it('checks all three layer vectors, not just the first', () => {
    expect(parseSacn(sacnData({ rootVector: 0x00000008 }))).toBeNull()
    expect(parseSacn(sacnData({ framingVector: 0x00000003 }))).toBeNull()
    expect(parseSacn(sacnData({ dmpVector: 0x03 }))).toBeNull()
  })

  it('checks the preamble and the ACN identifier', () => {
    expect(parseSacn(sacnData({ preamble: 0x0011 }))).toBeNull()
    expect(parseSacn(sacnData({ acnId: 'ASC-E1.31\0\0\0' }))).toBeNull()
  })

  it('checks the DMP layer addresses one flat run of bytes from zero', () => {
    // E1.31 fixes all three: a DMX packet always writes single-byte
    // properties, starting at address 0, stepping by 1. Something on the
    // port that addresses differently is not levels, and reading it as
    // levels would put real-looking numbers at offsets that mean nothing.
    //
    // Both implementations this was cross-checked against — libe131 and the
    // Hundemeier Python library — reject on all three; crewbox checked none
    // of them until this test.
    expect(parseSacn(sacnData({ addressType: 0xa2 }))).toBeNull()
    expect(parseSacn(sacnData({ firstAddress: 0x0001 }))).toBeNull()
    expect(parseSacn(sacnData({ addressIncrement: 0x0002 }))).toBeNull()
    expect(parseSacn(sacnData())).not.toBeNull()
  })

  it('caps a priority above the legal ceiling instead of believing it', () => {
    // 200 is the most a legal source may ask for. Letting 255 through would
    // hand the universe to whatever is malformed over a console correctly
    // asking for 200 — and dropping the packet would lose a rig over a byte.
    expect(parseSacn(sacnData({ priority: 255 }))!.priority).toBe(200)
    expect(parseSacn(sacnData({ priority: 200 }))!.priority).toBe(200)
    expect(parseSacn(sacnData({ priority: 100 }))!.priority).toBe(100)
  })

  it('ignores start codes that are not DMX', () => {
    // 0xcc is RDM. Reading it as levels would show a rig doing nonsense.
    expect(parseSacn(sacnData({ startCode: 0xcc }))).toBeNull()
    expect(parseSacn(sacnData({ startCode: 0x00 }))).not.toBeNull()
  })

  it('rejects a universe outside the legal range', () => {
    expect(parseSacn(sacnData({ universe: 0 }))).toBeNull()
  })

  it('survives a packet that stops mid-header', () => {
    expect(parseSacn(sacnData().subarray(0, 100))).toBeNull()
  })

  it('trusts the datagram over a count that overclaims', () => {
    const frame = parseSacn(sacnData({ slots: [1, 2, 3], declaredCount: 513 }))!
    expect([...frame.slots]).toEqual([1, 2, 3])
  })

  it('accepts a universe with no slots in it', () => {
    // 126 bytes: header and a start code, nothing else. Legal, and a source
    // that has genuinely nothing to say should not look like a parse failure.
    const frame = parseSacn(sacnData({ slots: [] }))
    expect(frame).not.toBeNull()
    expect(frame!.slots.length).toBe(0)
  })

  it('caps at a universe even if the sender sends more', () => {
    expect(parseSacn(sacnData({ slots: new Array(600).fill(9) }))!.slots.length).toBe(512)
  })
})
