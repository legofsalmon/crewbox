import { describe, expect, it } from 'vitest'
import type { DmxUniverseWire } from '@crewbox/shared'
import {
  decodeEverLit,
  fixtureDim,
  fixturePeak,
  fixtureVerdict,
  liveSummary,
  universesInPlot,
} from './live'
import { emptyFixture, type Fixture } from './types'

const fixture = (over: Partial<Fixture> = {}): Fixture => ({
  ...emptyFixture(),
  id: 'f1',
  universe: 1,
  address: 1,
  footprint: 1,
  ...over,
})

/** A 64-byte bitmap with the given 1-based addresses set. */
const lit = (...addresses: number[]): Uint8Array => {
  const bits = new Uint8Array(64)
  for (const address of addresses) bits[(address - 1) >> 3]! |= 1 << ((address - 1) & 7)
  return bits
}

const slots = (values: Record<number, number>): Uint8Array => {
  const out = new Uint8Array(512)
  for (const [address, level] of Object.entries(values)) out[Number(address) - 1] = level
  return out
}

describe('unpacking what the box sent', () => {
  it('round-trips a bitmap through base64', () => {
    const bits = lit(1, 9, 512)
    const encoded = btoa(String.fromCharCode(...bits))
    expect([...decodeEverLit(encoded)]).toEqual([...bits])
  })
})

describe('what can be said about a fixture', () => {
  it('says no-data when its universe was never heard', () => {
    expect(fixtureVerdict(fixture({ universe: 7 }), new Map())).toBe('no-data')
  })

  it('says silent when the universe is live but these addresses never were', () => {
    // The useful one: this is "the desk is not sending here", not "broken".
    const everLit = new Map([[1, lit(1)]])
    expect(fixtureVerdict(fixture({ address: 100, footprint: 16 }), everLit)).toBe('silent')
  })

  it('says live when any address in the footprint has been used', () => {
    const everLit = new Map([[1, lit(20)]])
    // A Sharpy at 17 occupies 17–32, and 20 is inside it.
    expect(fixtureVerdict(fixture({ address: 17, footprint: 16 }), everLit)).toBe('live')
    expect(fixtureVerdict(fixture({ address: 33, footprint: 16 }), everLit)).toBe('silent')
  })

  it('does not run past the end of a universe', () => {
    const everLit = new Map([[1, lit(512)]])
    expect(fixtureVerdict(fixture({ address: 500, footprint: 32 }), everLit)).toBe('live')
    expect(fixtureVerdict(fixture({ address: 0 }), everLit)).toBe('no-data')
    expect(fixtureVerdict(fixture({ address: 513 }), everLit)).toBe('no-data')
  })

  it('treats an unaddressed fixture as unknown rather than silent', () => {
    // address 0 means "not addressed yet" in the plot, not "channel zero".
    expect(fixtureVerdict(fixture({ address: 0 }), new Map([[1, lit(1)]]))).toBe('no-data')
  })
})

describe('how much is being asked of a fixture', () => {
  it('takes the highest value anywhere in the footprint', () => {
    // Not "intensity": nothing here knows which channel of a moving head is
    // the dimmer, so a head panning hard and dark would read as full.
    const levels = new Map([[1, slots({ 17: 0, 18: 200, 19: 10 })]])
    expect(fixturePeak(fixture({ address: 17, footprint: 16 }), levels)).toBe(200)
  })

  it('is null when this universe has no levels', () => {
    expect(fixturePeak(fixture(), new Map())).toBeNull()
  })

  it('dims towards a floor rather than to nothing', () => {
    // A fixture at zero is still rigged there; vanishing it is a worse drawing.
    const dark = new Map([[1, slots({ 1: 0 })]])
    const full = new Map([[1, slots({ 1: 255 })]])
    expect(fixtureDim(fixture(), dark)).toBeCloseTo(0.25)
    expect(fixtureDim(fixture(), full)).toBeCloseTo(1)
    expect(fixtureDim(fixture({ universe: 9 }), dark)).toBe(1)
  })
})

describe('the summary line', () => {
  const universe = (over: Partial<DmxUniverseWire> = {}): DmxUniverseWire => ({
    universe: 1,
    wireUniverse: 1,
    protocol: 'sacn',
    source: 'grandMA3',
    sources: 1,
    conflict: false,
    since: 5000,
    lastSeen: 9000,
    everLit: '',
    ...over,
  })

  it('counts the three states separately', () => {
    const fixtures = [
      fixture({ id: 'a', address: 1 }),
      fixture({ id: 'b', address: 100 }),
      fixture({ id: 'c', universe: 4, address: 1 }),
    ]
    const summary = liveSummary(fixtures, new Map([[1, lit(1)]]), [universe()])
    expect(summary).toMatchObject({ live: 1, silent: 1, missing: 1 })
  })

  it('reports the earliest window any universe can speak for', () => {
    // Two universes heard at different times: the counts are only honest back
    // to whichever started listening later — so show the earliest, plainly.
    const summary = liveSummary([], new Map(), [
      universe({ since: 5000 }),
      universe({ universe: 2, since: 3000 }),
    ])
    expect(summary.since).toBe(3000)
  })

  it('collects the universes with two sources fighting', () => {
    const summary = liveSummary([], new Map(), [
      universe(),
      universe({ universe: 3, conflict: true }),
    ])
    expect(summary.conflicts).toEqual([3])
  })
})

describe('what to ask the box about', () => {
  it('lists each universe the plot uses once, in order', () => {
    expect(universesInPlot([fixture({ universe: 3 }), fixture({ universe: 1 })])).toEqual([1, 3])
    expect(universesInPlot([fixture(), fixture()])).toEqual([1])
  })

  it('stops at the protocol cap rather than sending a request that is rejected', () => {
    const many = Array.from({ length: 40 }, (_, i) => fixture({ universe: i + 1 }))
    expect(universesInPlot(many)).toHaveLength(32)
  })
})
