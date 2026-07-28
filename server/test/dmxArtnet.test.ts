import { describe, expect, it } from 'vitest'
import { parseArtNet } from '../src/dmx/artnet.ts'
import { artDmx, artPollReply } from './dmxPackets.ts'

// Packets here are synthesised, not captured off a rig — see dmxPackets.ts for
// why that matters and what would replace it.

const dmx = (buf: Buffer) => {
  const packet = parseArtNet(buf, '2.0.0.10')
  if (packet?.kind !== 'dmx') throw new Error('expected an ArtDmx packet')
  return packet.frame
}

describe('Art-Net: what it accepts', () => {
  it('reads levels off a well-formed packet', () => {
    const frame = dmx(artDmx({ slots: [255, 128, 0, 64] }))
    expect([...frame.slots]).toEqual([255, 128, 0, 64])
    expect(frame.protocol).toBe('artnet')
    expect(frame.sourceId).toBe('2.0.0.10')
  })

  it('reads the universe out of a little-endian pair', () => {
    // The field where Art-Net's endianness catches people: SubUni is the low
    // byte and Net the high one, so Net 1 / SubUni 2 is universe 258.
    expect(dmx(artDmx({ universe: 0 })).wireUniverse).toBe(0)
    expect(dmx(artDmx({ universe: 5 })).wireUniverse).toBe(5)
    expect(dmx(artDmx({ universe: 258 })).wireUniverse).toBe(258)
    expect(dmx(artDmx({ universe: 32767 })).wireUniverse).toBe(32767)
  })

  it('reads the length big-endian, unlike the opcode', () => {
    // 300 is 0x012c — big-endian it is 300, little-endian it is 11265, and a
    // parser that got this backwards would claim a 24-way rig sent 6144 slots.
    expect(dmx(artDmx({ slots: new Array(300).fill(7) })).slots.length).toBe(300)
  })

  it('treats sequence 0 as unsequenced rather than as frame zero', () => {
    expect(dmx(artDmx({ sequence: 0 })).sequenced).toBe(false)
    expect(dmx(artDmx({ sequence: 1 })).sequenced).toBe(true)
  })

  it('gives every Art-Net source the same priority', () => {
    // The protocol has no priority field, so two senders on one universe are a
    // genuine tie — which is what makes them a reportable conflict.
    expect(dmx(artDmx()).priority).toBe(100)
  })

  it('has no preview or terminate concept', () => {
    const frame = dmx(artDmx())
    expect(frame.preview).toBe(false)
    expect(frame.terminated).toBe(false)
  })
})

describe('Art-Net: what it rejects', () => {
  it('ignores anything that is not Art-Net', () => {
    expect(parseArtNet(Buffer.from('hello there, port'), '2.0.0.10')).toBeNull()
    expect(parseArtNet(artDmx({ id: 'Art-Nut\0' }), '2.0.0.10')).toBeNull()
    expect(parseArtNet(Buffer.alloc(0), '2.0.0.10')).toBeNull()
  })

  it('ignores opcodes it has no use for', () => {
    // ArtPoll. Notably we never answer one either — that would be transmitting.
    expect(parseArtNet(artDmx({ opcode: 0x2000 }), '2.0.0.10')).toBeNull()
  })

  it('ignores a protocol version older than the fields it would read', () => {
    expect(parseArtNet(artDmx({ protVer: 13 }), '2.0.0.10')).toBeNull()
    expect(parseArtNet(artDmx({ protVer: 14 }), '2.0.0.10')).not.toBeNull()
  })

  it('trusts the datagram over a length that overclaims', () => {
    // Truncation is commoner than a short packet, and believing the header
    // would read off the end of the buffer.
    expect([...dmx(artDmx({ slots: [1, 2, 3], declaredLength: 512 })).slots]).toEqual([1, 2, 3])
  })

  it('caps at a universe even if the sender sends more', () => {
    expect(dmx(artDmx({ slots: new Array(600).fill(9) })).slots.length).toBe(512)
  })

  it('survives a header that stops mid-packet', () => {
    expect(parseArtNet(artDmx().subarray(0, 14), '2.0.0.10')).toBeNull()
  })
})

describe('Art-Net: nodes that announce themselves', () => {
  it('reads a name out of a reply nobody asked for', () => {
    const packet = parseArtNet(artPollReply('2.0.0.7', 'Node7', 'Stage Left Node'), '2.0.0.7')
    expect(packet?.kind).toBe('pollReply')
    if (packet?.kind !== 'pollReply') return
    expect(packet.reply.shortName).toBe('Node7')
    expect(packet.reply.longName).toBe('Stage Left Node')
    expect(packet.reply.ip).toBe('2.0.0.7')
  })

  it('degrades to an empty name rather than discarding a short reply', () => {
    // Names only ever improve a label, so an odd reply should cost the name
    // and nothing else. A field that is only half present reads as empty
    // rather than as half a name: "Node" when the node is called "Node7" is a
    // small lie and '' is not. These offsets are the least-verified thing in
    // this file — a real capture would settle them.
    const packet = parseArtNet(
      artPollReply('2.0.0.7', 'Node7', 'Stage Left').subarray(0, 50),
      '2.0.0.7'
    )
    expect(packet?.kind).toBe('pollReply')
    if (packet?.kind !== 'pollReply') return
    expect(packet.reply.shortName).toBe('Node7')
    expect(packet.reply.longName).toBe('')
  })
})
