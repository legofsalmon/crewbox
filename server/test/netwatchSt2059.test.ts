import { beforeAll, describe, expect, it } from 'vitest'
import {
  DECODE_EVERY_MS,
  DOMAIN_TIMEOUT_MS,
  FINDING_TIMEOUT_MS,
  MAX_SENDERS,
  VideoClockState,
  describeDomain,
  faultFix,
  isFault,
  isWorthALook,
  type VideoClockDomain,
  type VideoClockFinding,
} from '../src/netwatch/st2059.ts'
import { loadSt2110, type St2110 } from '../src/st2110.ts'

/**
 * The video clock with the real checks, fed the messages legofsalmon/st2110's
 * own tests decode (crates/ptp/tests/fixtures): an ST 2059-2 grandmaster at
 * noon UTC on 27 September 2026, and one set up wrong. What is tested is
 * which messages crewbox looks at, how often, and what it keeps.
 */

const hex = (h: string) => Buffer.from(h, 'hex')

const GOOD = {
  announce: hex(
    '0b0200407f00003c000000000000000000000000080011fffe21e1b000010001050000006ab90566000000000025008006214e5d80080011fffe21e1b0000020'
  ),
  sync: hex(
    '0002002c7f000200000000000000000000000000080011fffe21e1b00001000800fd00006ab90566075bcd15'
  ),
  followUp: hex(
    '0802002c7f000000000000000001800000000000080011fffe21e1b00001000802fd00006ab90566075bcdfd'
  ),
  delayResp: hex(
    '090200367f000000000000000000000000000000080011fffe21e1b00001000303fd00006ab9056607735940001b21fffe8a2c100001'
  ),
  metadata: hex(
    '0d0200647f000000000000000000000000000000080011fffe21e1b000010001047fffffffffffffffffffff00000300000300306897e800000100007530000003e9040100000debfffff1f000006add54b500006ab9a01500006ab84e9500000deb0500'
  ),
}

const BAD = {
  /** A free-running grandmaster with no traceable time. */
  announce: hex(
    '0b0200407f00000c000000000000000000000000080011fffe21e1b000010002050000006ab905670000000000250080f8fe4e5d80080011fffe21e1b0000020'
  ),
  /** Sync once a second, too slow for ST 2059-2. */
  sync: hex(
    '0002002c7f000200000000000000000000000000080011fffe21e1b000010009000000006ab9056700000000'
  ),
  /** The next jam at five past midnight. */
  metadata: hex(
    '0d0200647f000000000000000000000000000000080011fffe21e1b000010002047fffffffffffffffffffff00000300000300306897e800000100007530000003e9040100000debfffff1f000006add54b500006ab9a14100006ab84e9500000deb0500'
  ),
  /** A Sync cut short. */
  cut: hex('0002002c7f000000000000000000000000000000080011fffe21e1b00001000000fd00006ab90567'),
}

/** The same message on another domain (header byte 4). */
const onDomain = (buf: Buffer, domain: number): Buffer => {
  const copy = Buffer.from(buf)
  copy[4] = domain
  return copy
}

/** The same message from another clock (sourcePortIdentity, bytes 20–29). */
const fromClock = (buf: Buffer, n: number): Buffer => {
  const copy = Buffer.from(buf)
  copy.writeUInt32BE(n, 24)
  return copy
}

let checks: St2110
let decodes = 0
const state = () =>
  new VideoClockState({
    decode: (buf) => {
      decodes++
      return checks.decodePtp(buf)
    },
  })

beforeAll(async () => {
  checks = (await loadSt2110())!
})

const shortId = (id: string) => id.replace(':ff:fe:', ':').toUpperCase()

describe('the video clock', () => {
  it('reads a healthy grandmaster down to its facts, with nothing to report', () => {
    const video = state()
    for (const buf of Object.values(GOOD)) video.apply(buf, 1000)
    const [domain, ...rest] = video.status()
    expect(rest).toEqual([])
    expect(domain).toMatchObject({
      domain: 127,
      grandmaster: '08:00:11:ff:fe:21:e1:b0',
      clockClass: 6,
      ptpTimescale: true,
      utcOffset: 37,
      metadata: {
        frameRate: '30000/1001',
        dropFrame: true,
        locking: 'externally locked',
        localOffset: 3563,
      },
      findings: [],
    })
    expect(describeDomain(domain!, shortId)).toBe(
      'Domain 127: grandmaster 08:00:11:21:E1:B0, locked (class 6); ' +
        '29.97 fps drop-frame, externally locked, local time UTC+01:00'
    )
  })

  it('keeps what breaks the profile, faults first, and who sent it', () => {
    const video = state()
    for (const buf of [BAD.announce, BAD.sync, BAD.metadata]) video.apply(buf, 1000)
    const findings = video.status()[0]!.findings
    expect(findings.map((f) => [f.severity, f.rule])).toEqual([
      ['error', 'sm-jam-time'],
      ['error', 'sync-interval'],
      ['warning', 'clock-accuracy'],
      ['warning', 'gm-clock-class'],
    ])
    const slow = findings.find((f) => f.rule === 'sync-interval')!
    expect(slow).toMatchObject({ messageType: 'Sync', source: '08:00:11:ff:fe:21:e1:b0' })
    expect(slow.message).toMatch(/one a second/)
    // A free-running grandmaster is said in its description, not as a fault.
    expect(findings.filter(isFault).map((f) => f.rule)).toEqual(['sm-jam-time', 'sync-interval'])
    expect(findings.filter(isWorthALook)).toEqual([])
    expect(describeDomain(video.status()[0]!, shortId)).toContain('free-running (class 248)')
  })

  it('leaves other domains to the audio profile, unless metadata names them', () => {
    const video = state()
    video.apply(onDomain(BAD.sync, 0), 1000) // Dante's domain, AES67's rates
    expect(video.status()).toEqual([])

    video.apply(onDomain(GOOD.metadata, 0), 2000)
    video.apply(onDomain(BAD.sync, 0), 2000)
    expect(video.status().map((d) => [d.domain, d.findings.map((f) => f.rule)])).toEqual([
      [0, ['sync-interval']],
    ])
  })

  it('decodes one message of a kind from a clock a second', () => {
    const video = state()
    decodes = 0
    for (let at = 1000; at < 2000; at += 125) video.apply(GOOD.sync, at) // 8 a second
    expect(decodes).toBe(1)
    video.apply(GOOD.followUp, 1500) // another kind: its own second
    expect(decodes).toBe(2)
    video.apply(GOOD.sync, 1000 + DECODE_EVERY_MS)
    expect(decodes).toBe(3)
  })

  it('keeps track of only so many clocks, so a flood of them is not a flood of work', () => {
    const video = state()
    decodes = 0
    for (let n = 0; n < MAX_SENDERS + 50; n++) video.apply(fromClock(GOOD.sync, n), 1000)
    expect(decodes).toBe(MAX_SENDERS)
    video.sweep(1000 + DECODE_EVERY_MS)
    video.apply(fromClock(GOOD.sync, MAX_SENDERS + 49), 1000 + DECODE_EVERY_MS)
    expect(decodes).toBe(MAX_SENDERS + 1)
  })

  it('never decodes followers, junk, or PTPv1', () => {
    const video = state()
    decodes = 0
    const delayReq = Buffer.from(GOOD.sync)
    delayReq[0] = 0x01
    video.apply(delayReq, 1000)
    video.apply(Buffer.alloc(10), 1000)
    const v1 = Buffer.alloc(40)
    v1.writeUInt16BE(1, 0)
    video.apply(v1, 1000)
    expect(decodes).toBe(0)
  })

  it('survives a message the checks refuse, and records nothing without them', () => {
    const video = state()
    expect(() => video.apply(BAD.cut, 1000)).not.toThrow()
    expect(video.status()).toEqual([])

    const unloaded = new VideoClockState({ decode: () => null })
    unloaded.apply(GOOD.announce, 1000)
    expect(unloaded.status()).toEqual([])
    const without = new VideoClockState()
    without.apply(GOOD.announce, 1000)
    expect(without.status()).toEqual([])
  })

  it('forgets a fixed fault, then a silent domain', () => {
    const video = state()
    video.apply(BAD.sync, 1000)
    video.apply(GOOD.metadata, 1000)
    video.sweep(1000 + FINDING_TIMEOUT_MS)
    expect(video.status()[0]!.findings).toHaveLength(1)
    video.sweep(1001 + FINDING_TIMEOUT_MS)
    expect(video.status()[0]!.findings).toEqual([])
    expect(video.status()[0]!.metadata).toBeNull()
    video.sweep(1001 + DOMAIN_TIMEOUT_MS)
    expect(video.status()).toEqual([])
  })
})

describe('what the panels say', () => {
  const finding = (over: Partial<VideoClockFinding>): VideoClockFinding => ({
    rule: 'sync-interval',
    severity: 'error',
    message: 'm',
    messageType: 'Sync',
    source: '08:00:11:ff:fe:21:e1:b0',
    lastSeen: 0,
    ...over,
  })
  const domain = (over: Partial<VideoClockDomain>): VideoClockDomain => ({
    domain: 127,
    grandmaster: null,
    clockClass: null,
    ptpTimescale: null,
    utcOffset: null,
    metadata: null,
    findings: [],
    lastHeard: 0,
    ...over,
  })

  it('counts a wrong UTC offset as a fault, though the checks call it a warning', () => {
    const offset = finding({ rule: 'utc-offset', severity: 'warning' })
    expect(isFault(offset)).toBe(true)
    expect(faultFix(offset)).toMatch(/37 s/)
    expect(faultFix(finding({ rule: 'sm-jam-time' }))).toMatch(/daily jam/)
    expect(faultFix(finding({}))).toMatch(/SMPTE ST 2059-2 profile/)
    expect(isWorthALook(finding({ rule: 'sm-jump', severity: 'warning' }))).toBe(true)
  })

  it('describes what it has heard, and says what it has not', () => {
    expect(describeDomain(domain({}), shortId)).toBe(
      'Domain 127: no Announce heard yet; no synchronization metadata'
    )
    const arbitrary = domain({
      grandmaster: '08:00:11:ff:fe:21:e1:b0',
      clockClass: 13,
      ptpTimescale: false,
      metadata: {
        frameRate: '50/1',
        dropFrame: false,
        locking: 'internal',
        localOffset: -37 - 5 * 3600,
        lastSeen: 0,
      },
    })
    expect(describeDomain(arbitrary, shortId)).toBe(
      'Domain 127: grandmaster 08:00:11:21:E1:B0, locked (class 13), on an arbitrary timescale; ' +
        '50 fps, internal, local time UTC-05:00'
    )
  })
})
