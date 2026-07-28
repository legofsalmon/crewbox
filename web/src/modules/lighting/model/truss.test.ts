import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FIXTURE_WIDTH,
  DEFAULT_GAP,
  describeSticks,
  estimateTruss,
  packSticks,
  STICK_LENGTHS,
} from './truss'
import { emptyFixture, type Fixture, type FixtureType, type Position } from './types'

const truss = (over: Partial<Position> = {}): Position => ({
  id: 'p1',
  name: 'Truss 1',
  kind: 'truss',
  x: 0,
  y: 6,
  z: 6,
  length: 12,
  rotation: 0,
  ...over,
})

const fixtures = (count: number, over: Partial<Fixture> = {}): Fixture[] =>
  Array.from({ length: count }, (_, i) => ({ ...emptyFixture(), id: `f${i}`, ...over }))

describe('packing sticks', () => {
  it('uses as few sticks as it can', () => {
    expect(packSticks(8)).toEqual([4, 4])
    expect(packSticks(6.5)).toEqual([4, 2.5])
  })

  it('rounds up to something you can actually buy', () => {
    // 9.6 m of fixtures still needs 10 m of truss — you can't order 9.6.
    const sticks = packSticks(9.6)
    const total = sticks.reduce((sum, s) => sum + s, 0)
    expect(total).toBeGreaterThanOrEqual(9.6)
    expect(total).toBe(10)
    expect(sticks.every((s) => STICK_LENGTHS.includes(s))).toBe(true)
  })

  it('never rounds down, at any length', () => {
    for (let metres = 0.1; metres < 25; metres += 0.1) {
      const total = packSticks(metres).reduce((sum, s) => sum + s, 0)
      expect(total).toBeGreaterThanOrEqual(metres - 1e-9)
      // ...and never wastes more than the smallest stick doing it.
      expect(total - metres).toBeLessThan(0.5)
    }
  })

  it('gives an exact length exactly, not a stick more', () => {
    expect(packSticks(4).reduce((sum, s) => sum + s, 0)).toBe(4)
  })

  it('always answers, even for a hand-width of truss', () => {
    expect(packSticks(0.01)).toEqual([0.5])
  })
})

describe('estimating from the fixture list', () => {
  it('adds up widths and the gaps between them', () => {
    // Four unknown-type fixtures: 4 × 0.4 m + 3 × 0.25 m of air = 2.35 m.
    const estimate = estimateTruss(truss(), fixtures(4), [])!
    expect(estimate.needed).toBeCloseTo(4 * DEFAULT_FIXTURE_WIDTH + 3 * DEFAULT_GAP)
    expect(estimate.basis).toBe('fixtures')
    expect(estimate.built).toBeGreaterThanOrEqual(estimate.needed)
  })

  it('uses the type width when the type has one', () => {
    // A 1 m batten needs a lot more bar than a 400 mm moving head.
    const custom: FixtureType[] = [
      { id: 'batten', name: 'Batten', modes: [{ name: '4 ch', footprint: 4 }], width: 1 },
    ]
    const wide = estimateTruss(truss(), fixtures(4, { typeId: 'batten' }), custom)!
    const narrow = estimateTruss(truss(), fixtures(4), custom)!
    expect(wide.needed).toBeGreaterThan(narrow.needed)
    expect(wide.needed).toBeCloseTo(4 * 1 + 3 * DEFAULT_GAP)
  })

  it('needs no gap for a single fixture', () => {
    expect(estimateTruss(truss(), fixtures(1), [])!.needed).toBeCloseTo(DEFAULT_FIXTURE_WIDTH)
  })

  it('says nothing about an empty position', () => {
    expect(estimateTruss(truss(), [], [])).toBeNull()
  })

  it('says nothing about a boom', () => {
    // A boom's length is a stand height, not a run of truss to order.
    expect(estimateTruss(truss({ kind: 'boom' }), fixtures(4), [])).toBeNull()
  })
})

describe('estimating from real coordinates', () => {
  it('measures the span rather than assuming the spacing', () => {
    // An MVR import knows where the fixtures actually are. Four heads
    // spread over 9 m need 9 m of truss however tightly they'd pack.
    const placed = [0, 3, 6, 9].map((x, i) => ({
      ...emptyFixture(),
      id: `f${i}`,
      x,
      y: 6,
      z: 6,
    }))
    const estimate = estimateTruss(truss(), placed, [])!
    expect(estimate.basis).toBe('coordinates')
    // 9 m centre to centre, plus half a fixture hanging off each end.
    expect(estimate.needed).toBeGreaterThan(9)
    expect(estimate.needed).toBeLessThan(10)
  })

  it('falls back to widths when only one fixture is placed', () => {
    // Two points define a line; one defines nothing to measure.
    const mixed = [
      { ...emptyFixture(), id: 'a', x: 0, y: 6, z: 6 },
      { ...emptyFixture(), id: 'b' },
    ]
    expect(estimateTruss(truss(), mixed, [])!.basis).toBe('fixtures')
  })

  it('measures a diagonal run along its own axis', () => {
    // A raked position isn't axis-aligned, so a bounding box would
    // overstate it. Three fixtures 4 m apart on a diagonal span 8 m.
    const diagonal = [0, 1, 2].map((i) => ({
      ...emptyFixture(),
      id: `f${i}`,
      x: i * 4 * Math.SQRT1_2,
      y: i * 4 * Math.SQRT1_2,
      z: 6,
    }))
    const estimate = estimateTruss(truss(), diagonal, [])!
    expect(estimate.needed).toBeGreaterThan(8)
    expect(estimate.needed).toBeLessThan(9)
  })
})

describe('writing it down', () => {
  it('groups sticks the way a truss order does', () => {
    expect(describeSticks([4, 4, 2])).toBe('2 × 4 m + 1 × 2 m')
    expect(describeSticks([3])).toBe('1 × 3 m')
  })
})
