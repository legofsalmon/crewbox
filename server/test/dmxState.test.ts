import { describe, expect, it } from 'vitest'
import { DmxState, signedByteDiff } from '../src/dmx/state.ts'
import { DEFAULT_PRIORITY, type DmxFrame } from '../src/dmx/types.ts'

/**
 * These tests own the clock. Every timing rule in E1.31 — the 2.5 s data-loss
 * timeout, the sequence window — is a pure function of the timestamps handed
 * to `apply` and `sweep`, so none of this needs a socket or a wait.
 */

const frame = (over: Partial<DmxFrame> = {}): DmxFrame => ({
  protocol: 'sacn',
  wireUniverse: 1,
  sourceId: 'console-a',
  sourceName: 'Console A',
  priority: DEFAULT_PRIORITY,
  sequence: 1,
  sequenced: true,
  slots: new Uint8Array([0, 0, 0, 0]),
  preview: false,
  terminated: false,
  ...over,
})

/** Levels at 1-based addresses, in a 512-slot frame. */
const levels = (lit: Record<number, number>): Uint8Array => {
  const slots = new Uint8Array(512)
  for (const [address, level] of Object.entries(lit)) slots[Number(address) - 1] = level
  return slots
}

describe('mapping the wire onto a plot', () => {
  it('offsets Art-Net, which counts from zero, and leaves sACN alone', () => {
    // Getting this wrong moves every fixture 512 channels — invisible on
    // paper, extremely visible on stage.
    const state = new DmxState({ artnetBase: 1 })
    expect(state.plotUniverse({ protocol: 'artnet', wireUniverse: 0 })).toBe(1)
    expect(state.plotUniverse({ protocol: 'artnet', wireUniverse: 3 })).toBe(4)
    expect(state.plotUniverse({ protocol: 'sacn', wireUniverse: 1 })).toBe(1)
  })

  it('takes a different base when a rig is configured differently', () => {
    const state = new DmxState({ artnetBase: 0 })
    expect(state.plotUniverse({ protocol: 'artnet', wireUniverse: 0 })).toBe(0)
    expect(state.plotUniverse({ protocol: 'artnet', wireUniverse: 1 })).toBe(1)
  })

  it('keeps the wire number so both can be shown together', () => {
    const state = new DmxState({ artnetBase: 1 })
    state.apply(frame({ protocol: 'artnet', wireUniverse: 0, sequenced: false }), 1000)
    const [health] = state.health()
    expect(health.universe).toBe(1)
    expect(health.wireUniverse).toBe(0)
  })
})

describe('who is sending', () => {
  it('records a source and the universe it is on', () => {
    const state = new DmxState()
    state.apply(frame(), 1000)
    const [health] = state.health()
    expect(health.universe).toBe(1)
    expect(health.sources).toHaveLength(1)
    expect(health.sources[0].name).toBe('Console A')
    expect(health.winnerId).toBe('console-a')
    expect(health.conflict).toBe(false)
  })

  it('lets the higher priority win without calling it a conflict', () => {
    const state = new DmxState()
    state.apply(frame({ sourceId: 'a', priority: 100 }), 1000)
    state.apply(frame({ sourceId: 'b', priority: 150, slots: levels({ 1: 200 }) }), 1001)
    const [health] = state.health()
    expect(health.winnerId).toBe('b')
    expect(health.conflict).toBe(false)
    expect(state.levels(1)![0]).toBe(200)
  })

  it('calls an equal-priority tie a conflict', () => {
    // Two consoles patched to one universe is a classic festival fault that
    // runs a whole show before anyone notices, because E1.31 leaves what a
    // receiver does about it undefined.
    const state = new DmxState()
    state.apply(frame({ sourceId: 'a', priority: 100 }), 1000)
    state.apply(frame({ sourceId: 'b', priority: 100 }), 1001)
    expect(state.health()[0].conflict).toBe(true)
  })

  it('stops calling it a conflict once one of them goes away', () => {
    const state = new DmxState()
    state.apply(frame({ sourceId: 'a' }), 1000)
    state.apply(frame({ sourceId: 'b' }), 1000)
    expect(state.health()[0].conflict).toBe(true)
    state.apply(frame({ sourceId: 'b', terminated: true }), 1100)
    expect(state.health()[0].conflict).toBe(false)
    expect(state.health()[0].winnerId).toBe('a')
  })

  it('handles a termination arriving three times', () => {
    // Which is what the standard says a source does on the way out.
    const state = new DmxState()
    state.apply(frame({ sourceId: 'a' }), 1000)
    for (const t of [1100, 1101, 1102]) {
      state.apply(frame({ sourceId: 'a', terminated: true }), t)
    }
    expect(state.health()[0].sources).toHaveLength(0)
    expect(state.health()[0].winnerId).toBeNull()
  })

  it('drops a source that simply stops', () => {
    const state = new DmxState()
    state.apply(frame(), 1000)
    state.sweep(3000)
    expect(state.health()[0].sources).toHaveLength(1)
    // 2.5 s of silence is the standard's data-loss timeout.
    state.sweep(3600)
    expect(state.health()[0].sources).toHaveLength(0)
  })

  it('gives an Art-Net source the longer rope its protocol expects', () => {
    // The bug this pins: sACN sources stream continuously and E1.31 times
    // them out at 2.5 s, but an Art-Net sender parked on an unchanging look
    // is allowed to go quiet and re-send only every ~4 s. Judging it by
    // sACN's clock drops a healthy console between its own keep-alives, so
    // the panel flaps between "receiving" and "nothing arriving" for most of
    // a show — a monitor crying wolf is worse than no monitor.
    const state = new DmxState({ artnetBase: 0 })
    state.apply(frame({ protocol: 'artnet', sourceId: '2.0.0.7' }), 1000)

    // Well past sACN's timeout, and past a 4 s re-transmit interval.
    state.sweep(6000)
    expect(state.health()[0].sources).toHaveLength(1)

    // Two missed re-transmissions is genuinely gone.
    state.sweep(12_000)
    expect(state.health()[0].sources).toHaveLength(0)
  })

  it('times the two protocols independently on the same universe', () => {
    const state = new DmxState({ artnetBase: 0 })
    state.apply(frame({ protocol: 'sacn', sourceId: 'desk' }), 1000)
    state.apply(frame({ protocol: 'artnet', sourceId: '2.0.0.7' }), 1000)
    state.sweep(5000)
    expect(state.health()[0].sources.map((s) => s.protocol)).toEqual(['artnet'])
  })

  it('remembers the universe after every source has gone', () => {
    // "This universe was live and now nothing is sending it" is a much more
    // useful thing to say than forgetting it ever existed.
    const state = new DmxState()
    state.apply(frame(), 1000)
    state.sweep(9000)
    const [health] = state.health()
    expect(health.universe).toBe(1)
    expect(health.since).toBe(1000)
    expect(health.sources).toHaveLength(0)
  })

  it('names an Art-Net sender from a reply it volunteered', () => {
    const state = new DmxState()
    state.apply(frame({ protocol: 'artnet', sourceId: '2.0.0.7', sourceName: '' }), 1000)
    expect(state.health()[0].sources[0].name).toBe('')
    state.noteNode('2.0.0.7', 'Stage Left Node')
    expect(state.health()[0].sources[0].name).toBe('Stage Left Node')
  })
})

describe('what gets believed', () => {
  it('ignores a console previewing a cue', () => {
    // A preview is a desk showing itself something it has not output. Counting
    // it would light up a plot for a rig that is dark.
    const state = new DmxState()
    state.apply(frame({ preview: true, slots: levels({ 1: 255 }) }), 1000)
    expect(state.health()).toHaveLength(0)
    expect(state.verdict(1, 1, 1)).toBe('no-data')
  })

  it('discards a packet the network reordered', () => {
    const state = new DmxState()
    state.apply(frame({ sequence: 10, slots: levels({ 1: 100 }) }), 1000)
    state.apply(frame({ sequence: 9, slots: levels({ 1: 255 }) }), 1001)
    expect(state.levels(1)![0]).toBe(100)
  })

  it('accepts the next frame after a wrap', () => {
    // 255 → 1 is two forwards, not 254 backwards. Reading it as backwards
    // would throw away a run of good packets every time the counter turns over.
    const state = new DmxState()
    state.apply(frame({ sequence: 255, slots: levels({ 1: 100 }) }), 1000)
    state.apply(frame({ sequence: 1, slots: levels({ 1: 255 }) }), 1001)
    expect(state.levels(1)![0]).toBe(255)
  })

  it('accepts a big jump forward, which is loss rather than reordering', () => {
    const state = new DmxState()
    state.apply(frame({ sequence: 10, slots: levels({ 1: 100 }) }), 1000)
    state.apply(frame({ sequence: 80, slots: levels({ 1: 255 }) }), 1001)
    expect(state.levels(1)![0]).toBe(255)
  })

  it('does not apply the sequence rule to unsequenced Art-Net', () => {
    const state = new DmxState()
    // Wire universe 0, because Art-Net counts from zero and the default base
    // puts that on plot universe 1.
    const artnet = {
      protocol: 'artnet' as const,
      wireUniverse: 0,
      sequenced: false,
      sequence: 0,
    }
    state.apply(frame({ ...artnet, slots: levels({ 1: 100 }) }), 1000)
    state.apply(frame({ ...artnet, slots: levels({ 1: 255 }) }), 1001)
    expect(state.levels(1)![0]).toBe(255)
  })

  it('clears slots the new frame is too short to cover', () => {
    // A source that drops from 512 slots to 4 has not left 508 channels lit.
    const state = new DmxState()
    state.apply(frame({ sequence: 1, slots: levels({ 1: 10, 400: 200 }) }), 1000)
    expect(state.levels(1)![399]).toBe(200)
    state.apply(frame({ sequence: 2, slots: new Uint8Array([10, 0, 0, 0]) }), 1001)
    expect(state.levels(1)![399]).toBe(0)
  })
})

describe('what can honestly be said about a fixture', () => {
  it('says no-data when the universe has never been heard', () => {
    const state = new DmxState()
    expect(state.verdict(5, 1, 16)).toBe('no-data')
  })

  it('says silent when the universe is live but these addresses never are', () => {
    // The whole point: "the desk is not sending this", which is different from
    // "this fixture is broken" and different again from "nothing is arriving".
    const state = new DmxState()
    state.apply(frame({ slots: levels({ 1: 255 }) }), 1000)
    expect(state.verdict(1, 17, 16)).toBe('silent')
  })

  it('says live once any address in the footprint has been above zero', () => {
    const state = new DmxState()
    state.apply(frame({ slots: levels({ 20: 4 }) }), 1000)
    // A Sharpy at 17 occupies 17–32, and 20 is in it.
    expect(state.verdict(1, 17, 16)).toBe('live')
    // A fixture at 33 is not.
    expect(state.verdict(1, 33, 16)).toBe('silent')
  })

  it('stays live after the level goes back to zero', () => {
    // Otherwise every fixture would read as broken between cues.
    const state = new DmxState()
    state.apply(frame({ sequence: 1, slots: levels({ 5: 255 }) }), 1000)
    state.apply(frame({ sequence: 2, slots: levels({ 5: 0 }) }), 1100)
    expect(state.levels(1)![4]).toBe(0)
    expect(state.verdict(1, 5, 1)).toBe('live')
  })

  it('does not run off the end of a universe', () => {
    const state = new DmxState()
    state.apply(frame({ slots: levels({ 512: 255 }) }), 1000)
    expect(state.verdict(1, 500, 32)).toBe('live')
    expect(state.verdict(1, 513, 1)).toBe('no-data')
    expect(state.verdict(1, 0, 1)).toBe('no-data')
  })

  it('treats a zero footprint as one channel rather than none', () => {
    const state = new DmxState()
    state.apply(frame({ slots: levels({ 7: 9 }) }), 1000)
    expect(state.verdict(1, 7, 0)).toBe('live')
  })
})

describe('sequence arithmetic', () => {
  it('measures the shorter way round the byte', () => {
    expect(signedByteDiff(1, 255)).toBe(2)
    expect(signedByteDiff(255, 1)).toBe(-2)
    expect(signedByteDiff(5, 5)).toBe(0)
    expect(signedByteDiff(5, 4)).toBe(1)
    expect(signedByteDiff(4, 5)).toBe(-1)
    expect(signedByteDiff(127, 0)).toBe(127)
    expect(signedByteDiff(128, 0)).toBe(-128)
  })
})
