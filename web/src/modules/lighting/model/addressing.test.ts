import { describe, expect, it } from 'vitest'
import {
  findAddressConflicts,
  findOverruns,
  formatAddress,
  nextFreeAddress,
  parseAddress,
  universeUsage,
} from './addressing'
import { emptyFixture, type Fixture } from './types'

const fixture = (id: string, fields: Partial<Fixture> = {}): Fixture => ({
  id,
  ...emptyFixture(),
  ...fields,
})

describe('address conflicts', () => {
  it('flags fixtures whose channel ranges overlap in the same universe', () => {
    // A 16-channel head at 1 occupies 1–16; another at 10 occupies 10–25.
    const fixtures = [
      fixture('a', { universe: 1, address: 1, footprint: 16 }),
      fixture('b', { universe: 1, address: 10, footprint: 16 }),
      fixture('c', { universe: 1, address: 40, footprint: 16 }),
    ]
    const conflicts = findAddressConflicts(fixtures)

    expect(conflicts.get('a')).toEqual(['b'])
    expect(conflicts.get('b')).toEqual(['a'])
    expect(conflicts.has('c')).toBe(false)
  })

  it('treats the same address in different universes as fine', () => {
    const conflicts = findAddressConflicts([
      fixture('a', { universe: 1, address: 1, footprint: 32 }),
      fixture('b', { universe: 2, address: 1, footprint: 32 }),
    ])
    expect(conflicts.size).toBe(0)
  })

  it('catches a fixture landing exactly on another one’s last channel', () => {
    // The off-by-one that a "does the start address match" check misses.
    const conflicts = findAddressConflicts([
      fixture('a', { universe: 1, address: 1, footprint: 16 }),
      fixture('b', { universe: 1, address: 16, footprint: 4 }),
    ])
    expect(conflicts.get('a')).toEqual(['b'])
  })

  it('leaves nose-to-tail fixtures alone', () => {
    const conflicts = findAddressConflicts([
      fixture('a', { universe: 1, address: 1, footprint: 16 }),
      fixture('b', { universe: 1, address: 17, footprint: 4 }),
    ])
    expect(conflicts.size).toBe(0)
  })

  it('reports every fixture in a three-way pile-up', () => {
    const conflicts = findAddressConflicts([
      fixture('a', { universe: 1, address: 1, footprint: 20 }),
      fixture('b', { universe: 1, address: 5, footprint: 20 }),
      fixture('c', { universe: 1, address: 10, footprint: 20 }),
    ])
    expect(conflicts.get('a')?.sort()).toEqual(['b', 'c'])
    expect(conflicts.get('b')?.sort()).toEqual(['a', 'c'])
    expect(conflicts.get('c')?.sort()).toEqual(['a', 'b'])
  })

  it('ignores unaddressed fixtures rather than colliding them all at zero', () => {
    const conflicts = findAddressConflicts([
      fixture('a', { address: 0, footprint: 16 }),
      fixture('b', { address: 0, footprint: 16 }),
    ])
    expect(conflicts.size).toBe(0)
  })
})

describe('universe overruns', () => {
  it('flags a fixture whose footprint runs past channel 512', () => {
    expect(
      findOverruns([
        fixture('a', { universe: 1, address: 500, footprint: 32 }),
        fixture('b', { universe: 1, address: 480, footprint: 32 }),
      ])
    ).toEqual(['a'])
  })
})

describe('next free address', () => {
  it('finds the first gap large enough for the footprint', () => {
    const fixtures = [
      fixture('a', { universe: 1, address: 1, footprint: 16 }),
      fixture('b', { universe: 1, address: 21, footprint: 16 }),
    ]
    // 17–20 is free but only 4 wide, so a 16-channel head goes after 'b'.
    expect(nextFreeAddress(fixtures, 1, 16)).toBe(37)
    expect(nextFreeAddress(fixtures, 1, 4)).toBe(17)
  })

  it('starts at 1 in an empty universe', () => {
    expect(nextFreeAddress([], 3, 24)).toBe(1)
  })

  it('returns null when nothing fits', () => {
    const fixtures = [fixture('a', { universe: 1, address: 1, footprint: 500 })]
    expect(nextFreeAddress(fixtures, 1, 32)).toBeNull()
  })

  it('ignores the fixture being re-addressed', () => {
    const fixtures = [fixture('a', { universe: 1, address: 1, footprint: 16 })]
    expect(nextFreeAddress(fixtures, 1, 16, 'a')).toBe(1)
  })
})

describe('universe usage', () => {
  it('counts occupied channels without double-counting overlaps', () => {
    const [universe] = universeUsage([
      fixture('a', { universe: 1, address: 1, footprint: 16 }),
      fixture('b', { universe: 1, address: 10, footprint: 16 }),
    ])
    // 1–25 inclusive is 25 channels, not 32.
    expect(universe).toMatchObject({ universe: 1, used: 25, free: 487, fixtureCount: 2 })
  })

  it('reports the largest free run first', () => {
    const [universe] = universeUsage([fixture('a', { universe: 1, address: 100, footprint: 10 })])
    expect(universe!.gaps[0]).toEqual({ start: 110, end: 512 })
  })
})

describe('address parsing', () => {
  it.each([
    ['25', 1, 25],
    ['1/25', 1, 25],
    ['2/25', 2, 25],
    ['2.25', 2, 25],
    ['2:25', 2, 25],
    // Absolute addressing past one universe, as consoles export it.
    ['513', 2, 1],
    ['537', 2, 25],
    ['1024', 2, 512],
    ['1025', 3, 1],
  ])('parses %s', (input, universe, address) => {
    expect(parseAddress(input)).toEqual({ universe, address })
  })

  it.each(['', '  ', 'n/a', '1/0', '1/513', '0', 'A12'])('rejects %s', (input) => {
    expect(parseAddress(input)).toBeNull()
  })

  it('formats back for display', () => {
    expect(formatAddress(2, 25)).toBe('2/25')
    expect(formatAddress(1, 0)).toBe('')
  })
})
