import { describe, expect, it } from 'vitest'
import { MAX_STREAMS, SAP_TIMEOUT_MS, SapState, parseSap } from '../src/netwatch/sap.ts'

const SDP = [
  'v=0',
  'o=- 1423986 1423994 IN IP4 10.10.0.7',
  's=Monitor Mix L/R',
  'c=IN IP4 239.69.128.7/32',
  't=0 0',
  'm=audio 5004 RTP/AVP 98',
].join('\r\n')

const sap = ({ deletion = false, hash = 0x1234, sdp = SDP, mime = true } = {}): Buffer => {
  const header = Buffer.alloc(8)
  header[0] = 0x20 | (deletion ? 0x04 : 0) // V=1, T when deleting
  header[1] = 0 // no auth
  header.writeUInt16BE(hash, 2)
  Buffer.from([10, 10, 0, 7]).copy(header, 4) // originating source
  return Buffer.concat([
    header,
    mime ? Buffer.from('application/sdp\0', 'latin1') : Buffer.alloc(0),
    Buffer.from(sdp, 'utf8'),
  ])
}

describe('parsing SAP', () => {
  it('reads an announcement down to the stream facts', () => {
    const message = parseSap(sap())!
    expect(message.deletion).toBe(false)
    expect(message.sessionName).toBe('Monitor Mix L/R')
    expect(message.origin).toBe('10.10.0.7')
    expect(message.connection).toBe('239.69.128.7')
  })

  it('reads a bare-SDP packet, which older senders emit', () => {
    const message = parseSap(sap({ mime: false }))!
    expect(message.sessionName).toBe('Monitor Mix L/R')
  })

  it('marks a deletion as one', () => {
    expect(parseSap(sap({ deletion: true }))!.deletion).toBe(true)
  })

  it('refuses junk, wrong versions and encrypted payloads', () => {
    expect(parseSap(Buffer.alloc(4))).toBeNull()
    const wrongVersion = sap()
    wrongVersion[0] = 0x40
    expect(parseSap(wrongVersion)).toBeNull()
    const encrypted = sap()
    encrypted[0] |= 0x02
    expect(parseSap(encrypted)).toBeNull()
  })
})

describe('the stream directory', () => {
  it('lists announced streams and honours deletions', () => {
    const state = new SapState()
    state.apply(parseSap(sap())!, 1000)
    state.apply(parseSap(sap())!, 300_000) // periodic repeat, same stream
    expect(state.roster()).toHaveLength(1)
    expect(state.roster()[0]).toMatchObject({
      name: 'Monitor Mix L/R',
      connection: '239.69.128.7',
      firstSeen: 1000,
      lastSeen: 300_000,
    })
    state.apply(parseSap(sap({ deletion: true }))!, 400_000)
    expect(state.roster()).toHaveLength(0)
  })

  it('ages out a stream whose sender vanished without a goodbye', () => {
    const state = new SapState()
    state.apply(parseSap(sap())!, 1000)
    state.sweep(1000 + SAP_TIMEOUT_MS - 1)
    expect(state.roster()).toHaveLength(1)
    state.sweep(1000 + SAP_TIMEOUT_MS + 1)
    expect(state.roster()).toHaveLength(0)
  })

  it('stops listing at a bound, and says it did', () => {
    // Each entry holds its place for half an hour after its last
    // announcement and the id comes off the wire, so one sender could mint
    // unlimited streams that each occupy the directory for that long — and
    // every read sorts the whole thing.
    const state = new SapState()
    for (let i = 0; i < MAX_STREAMS + 20; i++) {
      state.apply(parseSap(sap({ hash: i + 1 }))!, 1000 + i)
    }
    expect(state.roster()).toHaveLength(MAX_STREAMS)
    expect(state.overflow()).toBe(20)
  })
})
