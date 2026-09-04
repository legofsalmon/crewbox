import { describe, expect, it } from 'vitest'
import {
  CLOCK_HISTORY_MS,
  GRANDMASTER_TIMEOUT_MS,
  PtpState,
  parsePtp,
  type PtpAnnounce,
} from '../src/netwatch/ptp.ts'

/**
 * Buffers are built field by field from IEEE 1588-2008's Announce layout, the
 * same way the DMX tests build theirs — and with the same caveat recorded in
 * docs: synthesised from the spec, awaiting captures from a real rig.
 */

const GM_A = Buffer.from([0x00, 0x1d, 0xc1, 0xff, 0xfe, 0x11, 0x22, 0x33])
const GM_B = Buffer.from([0x00, 0x0a, 0x92, 0xff, 0xfe, 0x44, 0x55, 0x66])

const announce = (
  grandmaster: Buffer,
  { domain = 0, priority1 = 128, clockClass = 248, sequenceId = 1 } = {}
): Buffer => {
  const buf = Buffer.alloc(64)
  buf[0] = 0x0b // messageType: Announce
  buf[1] = 0x02 // versionPTP: 2
  buf.writeUInt16BE(64, 2) // messageLength
  buf[4] = domain
  grandmaster.copy(buf, 20) // sourcePortIdentity: the GM announces itself
  buf.writeUInt16BE(sequenceId, 30)
  buf[47] = priority1
  buf[48] = clockClass
  buf[52] = 128 // priority2
  grandmaster.copy(buf, 53)
  buf.writeUInt16BE(0, 61) // stepsRemoved
  return buf
}

const v1sync = (): Buffer => {
  const buf = Buffer.alloc(60)
  buf.writeUInt16BE(1, 0) // versionPTP: 1
  buf[32] = 0 // control: Sync
  return buf
}

describe('parsing the wire', () => {
  it('decodes a v2 Announce completely', () => {
    const message = parsePtp(announce(GM_A, { priority1: 10, clockClass: 6 })) as PtpAnnounce
    expect(message.kind).toBe('announce')
    expect(message.grandmasterId).toBe('00:1d:c1:ff:fe:11:22:33')
    expect(message.priority1).toBe(10)
    expect(message.clockClass).toBe(6)
    expect(message.domain).toBe(0)
  })

  it('recognises v1 without pretending to decode it', () => {
    const message = parsePtp(v1sync())
    expect(message).toEqual({ version: 1, kind: 'v1', control: 0 })
  })

  it('refuses junk, short packets and unknown versions', () => {
    expect(parsePtp(Buffer.alloc(10))).toBeNull()
    const wrongVersion = announce(GM_A)
    wrongVersion[1] = 0x05
    expect(parsePtp(wrongVersion)).toBeNull()
    const truncatedAnnounce = announce(GM_A).subarray(0, 40)
    expect(parsePtp(Buffer.from(truncatedAnnounce))).toBeNull()
  })
})

describe('the grandmaster ledger', () => {
  it('one election at power-up is steady, not churn', () => {
    // The first announce this box hears is the clock it arrived to, not a
    // clock that moved. Recording it as a change meant the scorer graded
    // every start as "the clock is moving" for ten minutes — on a network
    // where nothing had happened at all. `since` carries when the reign
    // began, which is the thing worth knowing.
    const state = new PtpState()
    for (let i = 0; i < 10; i++) state.apply(parsePtp(announce(GM_A))!, 1000 + i * 2000)
    const status = state.status(21_000)
    expect(status.grandmasterId).toBe('00:1d:c1:ff:fe:11:22:33')
    expect(status.changes).toEqual([])
    expect(status.since).toBe(1000)
  })

  it('counts an election war change by change', () => {
    const state = new PtpState()
    state.apply(parsePtp(announce(GM_A))!, 1000)
    state.apply(parsePtp(announce(GM_B))!, 5000)
    state.apply(parsePtp(announce(GM_A))!, 9000)
    state.apply(parsePtp(announce(GM_B))!, 13_000)
    const status = state.status(14_000)
    // Three handovers between four announces — the first is arrival.
    expect(status.changes).toHaveLength(3)
    expect(status.changes[0]!.to).toBe('00:0a:92:ff:fe:44:55:66')
    // Two clocks announced within the timeout: the election is visibly live.
    expect(status.announcers).toBe(2)
  })

  it('reads silence as absence, never as another change', () => {
    const state = new PtpState()
    state.apply(parsePtp(announce(GM_A))!, 1000)
    state.sweep(1000 + GRANDMASTER_TIMEOUT_MS + 1)
    const status = state.status(1000 + GRANDMASTER_TIMEOUT_MS + 1)
    expect(status.grandmasterId).toBeNull()
    // A powered-down rig is not an election war — and neither was its
    // arrival, so there is nothing in the ledger at all.
    expect(status.changes).toEqual([])
  })

  it('does not read two stable domains as one clock changing hands', () => {
    // Dante on domain 0 and a video reference on 127 is an ordinary rig.
    // The ledger kept one grandmaster across every domain, so two clocks
    // that never moved traded the crown at announce rate — several times a
    // second, straight past "an election war", for a network where nothing
    // was wrong.
    const state = new PtpState()
    for (let i = 0; i < 6; i++) {
      state.apply(parsePtp(announce(GM_A, { domain: 0 }))!, 1000 + i * 1000)
      state.apply(parsePtp(announce(GM_B, { domain: 127 }))!, 1500 + i * 1000)
    }
    const status = state.status(7000)
    expect(status.changes).toEqual([])
    expect(status.domains).toBe(2)
    // Each domain has exactly one clock announcing, so no election either.
    expect(status.announcers).toBe(1)
  })

  it('still catches a war inside one domain while another is quiet', () => {
    const state = new PtpState()
    state.apply(parsePtp(announce(GM_A, { domain: 0 }))!, 1000)
    state.apply(parsePtp(announce(GM_A, { domain: 127 }))!, 1100)
    state.apply(parsePtp(announce(GM_B, { domain: 127 }))!, 2000)
    state.apply(parsePtp(announce(GM_A, { domain: 127 }))!, 3000)
    const status = state.status(3500)
    // The busiest domain is 127, and it really is trading hands.
    expect(status.domain).toBe(127)
    expect(status.changes).toHaveLength(2)
  })

  it('lets old changes age out of the story', () => {
    const state = new PtpState()
    state.apply(parsePtp(announce(GM_A))!, 1000)
    state.apply(parsePtp(announce(GM_B))!, 2000)
    const later = 2000 + CLOCK_HISTORY_MS + 1
    state.apply(parsePtp(announce(GM_B))!, later)
    state.sweep(later)
    // The morning's soundcheck scuffle is not tonight's problem.
    expect(state.status(later).changes).toHaveLength(0)
    expect(state.status(later).grandmasterId).toBe('00:0a:92:ff:fe:44:55:66')
  })

  it('reports v1 presence with a rate, and decays it honestly', () => {
    const state = new PtpState()
    for (let i = 0; i < 20; i++) state.apply(parsePtp(v1sync())!, 1000 + i * 100)
    let status = state.status(3000)
    expect(status.v1Seen).toBe(true)
    expect(status.v1RateHz).toBeGreaterThan(5)
    state.sweep(60_000)
    status = state.status(60_000)
    expect(status.v1Seen).toBe(false)
    expect(status.v1RateHz).toBe(0)
  })
})
