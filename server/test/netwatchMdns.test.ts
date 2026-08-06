import { describe, expect, it } from 'vitest'
import { MdnsState, parseMdns, serviceKind } from '../src/netwatch/mdns.ts'

/**
 * DNS wire format built by hand, compression pointers included — every real
 * mDNS packet uses them, so a parser that only handles the uncompressed form
 * would pass its tests and fail on the first stagebox.
 */

const label = (parts: string[]): Buffer =>
  Buffer.concat([
    ...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'utf8')])),
    Buffer.from([0]),
  ])

/** A compression pointer to `offset`. */
const pointer = (offset: number): Buffer => Buffer.from([0xc0 | (offset >> 8), offset & 0xff])

interface RawRecord {
  name: Buffer
  type: number
  ttl: number
  rdata: Buffer
}

const packet = (records: RawRecord[]): Buffer => {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2) // authoritative response
  header.writeUInt16BE(records.length, 6) // answer count
  return Buffer.concat([
    header,
    ...records.map((r) => {
      const fixed = Buffer.alloc(10)
      fixed.writeUInt16BE(r.type, 0)
      fixed.writeUInt16BE(1, 2) // class IN
      fixed.writeUInt32BE(r.ttl, 4)
      fixed.writeUInt16BE(r.rdata.length, 8)
      return Buffer.concat([r.name, fixed, r.rdata])
    }),
  ])
}

const DANTE_SERVICE = ['_netaudio-arc', '_udp', 'local']

describe('parsing mDNS', () => {
  it('reads PTR, SRV and A records from one announcement', () => {
    const records = parseMdns(
      packet([
        {
          name: label(DANTE_SERVICE),
          type: 12,
          ttl: 4500,
          rdata: label(['FOH-Stagebox', ...DANTE_SERVICE]),
        },
        {
          name: label(['FOH-Stagebox', ...DANTE_SERVICE]),
          type: 33,
          ttl: 120,
          rdata: Buffer.concat([Buffer.alloc(6), label(['foh-stagebox', 'local'])]),
        },
        {
          name: label(['foh-stagebox', 'local']),
          type: 1,
          ttl: 120,
          rdata: Buffer.from([10, 10, 0, 5]),
        },
      ])
    )
    expect(records).toHaveLength(3)
    expect(records[0]).toMatchObject({
      name: '_netaudio-arc._udp.local',
      type: 12,
      value: 'foh-stagebox._netaudio-arc._udp.local',
    })
    expect(records[1]!.value).toBe('foh-stagebox.local')
    expect(records[2]!.value).toBe('10.10.0.5')
  })

  it('follows compression pointers, which every real packet uses', () => {
    // The PTR rdata points back at the record's own name (offset 12, right
    // after the header) instead of repeating the labels.
    const instance = Buffer.concat([Buffer.from([5]), Buffer.from('Cam 1', 'utf8'), pointer(12)])
    const records = parseMdns(
      packet([{ name: label(['_ndi', '_tcp', 'local']), type: 12, ttl: 4500, rdata: instance }])
    )
    expect(records[0]!.value).toBe('cam 1._ndi._tcp.local')
  })

  it('survives junk: truncation, pointer loops, empty buffers', () => {
    expect(parseMdns(Buffer.alloc(0))).toEqual([])
    expect(parseMdns(Buffer.alloc(11))).toEqual([])
    // A pointer that points at itself must terminate, not spin.
    const loop = packet([{ name: pointer(12), type: 12, ttl: 1, rdata: Buffer.alloc(0) }])
    expect(parseMdns(loop)).toEqual([])
    const good = packet([
      {
        name: label(['_ndi', '_tcp', 'local']),
        type: 12,
        ttl: 1,
        rdata: label(['x', '_ndi', '_tcp', 'local']),
      },
    ])
    expect(parseMdns(good.subarray(0, good.length - 3))).toEqual([])
  })
})

describe('which services matter', () => {
  it('claims every Dante service flavour and NDI, nothing else', () => {
    expect(serviceKind('_netaudio-arc._udp.local')).toBe('dante')
    expect(serviceKind('_netaudio-dbc._udp.local')).toBe('dante')
    expect(serviceKind('_ndi._tcp.local')).toBe('ndi')
    expect(serviceKind('_http._tcp.local')).toBeNull()
    expect(serviceKind('_airplay._tcp.local')).toBeNull()
  })
})

describe('the device roster', () => {
  const dante = (name: string, ttl = 4500): RawRecord => ({
    name: label(DANTE_SERVICE),
    type: 12,
    ttl,
    rdata: label([name, ...DANTE_SERVICE]),
  })

  it('builds the roster from announcements, with addresses when bundled', () => {
    const state = new MdnsState()
    state.applyPacket(
      parseMdns(
        packet([
          dante('FOH-Stagebox'),
          {
            name: label(['FOH-Stagebox', ...DANTE_SERVICE]),
            type: 33,
            ttl: 120,
            rdata: Buffer.concat([Buffer.alloc(6), label(['foh-stagebox', 'local'])]),
          },
          {
            name: label(['foh-stagebox', 'local']),
            type: 1,
            ttl: 120,
            rdata: Buffer.from([10, 10, 0, 5]),
          },
        ])
      ),
      1000
    )
    const [device] = state.roster()
    expect(device).toMatchObject({
      name: 'foh-stagebox',
      kind: 'dante',
      address: '10.10.0.5',
      firstSeen: 1000,
      saidGoodbye: false,
    })
  })

  it('hears a goodbye for what it is, and a return for what that is', () => {
    const state = new MdnsState()
    state.applyPacket(parseMdns(packet([dante('Stagebox')])), 1000)
    state.applyPacket(parseMdns(packet([dante('Stagebox', 0)])), 5000) // TTL 0
    expect(state.roster()[0]!.saidGoodbye).toBe(true)
    state.applyPacket(parseMdns(packet([dante('Stagebox')])), 9000) // rebooted
    expect(state.roster()[0]!.saidGoodbye).toBe(false)
    expect(state.roster()).toHaveLength(1)
  })

  it('keeps a vanished device — the vanishing is the news', () => {
    const state = new MdnsState()
    state.applyPacket(parseMdns(packet([dante('Stagebox')])), 1000)
    expect(state.roster()).toHaveLength(1)
    expect(state.roster()[0]!.lastSeen).toBe(1000)
  })
})
