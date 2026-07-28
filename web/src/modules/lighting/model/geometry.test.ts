import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRIM,
  fixturePoint3,
  isVertical,
  plotPivot,
  positionEnds,
  project,
} from './geometry'
import { emptyFixture, type Fixture, type Position } from './types'

const position = (over: Partial<Position> = {}): Position => ({
  id: 'p1',
  name: 'Truss 1',
  kind: 'truss',
  x: 0,
  y: 6,
  z: 6,
  length: 10,
  rotation: 0,
  ...over,
})

const fixture = (over: Partial<Fixture> = {}): Fixture => ({
  ...emptyFixture(),
  id: 'f1',
  ...over,
})

describe('position geometry', () => {
  it('runs a level bar across the stage at its trim', () => {
    const [a, b] = positionEnds(position())
    expect(a).toEqual({ x: -5, y: 6, z: 6 })
    expect(b).toEqual({ x: 5, y: 6, z: 6 })
  })

  it('stands a boom up off the deck instead of laying it flat', () => {
    // A boom drawn as a horizontal line 3 m up is the difference between
    // four fixtures stacked on a stand and four spread across the stage.
    const boom = position({ kind: 'boom', x: -7, y: 2, z: 4 })
    expect(isVertical(boom)).toBe(true)
    const [a, b] = positionEnds(boom)
    expect(a).toEqual({ x: -7, y: 2, z: 0 })
    expect(b).toEqual({ x: -7, y: 2, z: 4 })
  })

  it('turns a bar by its rotation', () => {
    const [a, b] = positionEnds(position({ rotation: 90, length: 4 }))
    expect(a.x).toBeCloseTo(0)
    expect(a.y).toBeCloseTo(4)
    expect(b.y).toBeCloseTo(8)
  })
})

describe('fixture placement', () => {
  it('centres a lone fixture on its bar rather than on the corner', () => {
    const point = fixturePoint3(fixture(), position(), 0, 1)
    expect(point).toEqual({ x: 0, y: 6, z: 6 })
  })

  it('spreads fixtures with half-gaps at each end', () => {
    const p = position({ length: 10 })
    const xs = [0, 1, 2, 3, 4].map((i) => fixturePoint3(fixture(), p, i, 5).x)
    expect(xs).toEqual([-4, -2, 0, 2, 4])
  })

  it('walks fixtures up a boom', () => {
    const boom = position({ kind: 'boom', z: 4 })
    const zs = [0, 1].map((i) => fixturePoint3(fixture(), boom, i, 2).z)
    expect(zs).toEqual([1, 3])
  })

  it('keeps real coordinates when something authoritative supplied them', () => {
    // MVR groups by role as often as by bar, so spreading a placed fixture
    // along a line would invent a rig that isn't there.
    const point = fixturePoint3(fixture({ x: 3.5, y: 1.25, z: 2 }), position(), 0, 4)
    expect(point).toEqual({ x: 3.5, y: 1.25, z: 2 })
  })

  it('takes the position trim when only the height is missing', () => {
    const point = fixturePoint3(fixture({ x: 3.5, y: 1.25 }), position({ z: 7 }), 0, 4)
    expect(point).toEqual({ x: 3.5, y: 1.25, z: 7 })
  })

  it('ignores half a placement', () => {
    // x without y is not a position; mixing a real x with a spread y would
    // put the fixture somewhere neither the file nor the bar says it is.
    const point = fixturePoint3(fixture({ x: 3.5, y: null }), position(), 0, 1)
    expect(point.x).toBe(0)
  })
})

describe('projection', () => {
  const camera = { yaw: 0, pitch: 0, distance: 20 }
  const pivot = { x: 0, y: 0, z: 0 }

  it('puts the pivot in the middle of the frame', () => {
    const p = project(pivot, camera, pivot)
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(0)
  })

  it('draws height as up on the screen', () => {
    // Screen y grows downwards, so something 3 m up must project negative.
    expect(project({ x: 0, y: 0, z: 3 }, camera, pivot).y).toBeLessThan(0)
  })

  it('makes upstage things smaller and further away', () => {
    const near = project({ x: 0, y: -4, z: 0 }, camera, pivot)
    const far = project({ x: 0, y: 4, z: 0 }, camera, pivot)
    expect(far.depth).toBeGreaterThan(near.depth)
    expect(far.scale).toBeLessThan(near.scale)
  })

  it('spins the rig round when the camera yaws', () => {
    // At 90° of yaw, what was upstage is now off to one side.
    const level = project({ x: 0, y: 5, z: 0 }, { ...camera, yaw: 90 }, pivot)
    expect(Math.abs(level.x)).toBeGreaterThan(1)
  })

  it('never inverts, however close the camera gets', () => {
    // A point level with the camera would divide by zero without the clamp,
    // and a negative scale draws the whole rig inside out.
    const p = project({ x: 0, y: -100, z: 0 }, { yaw: 0, pitch: 0, distance: 20 }, pivot)
    expect(p.scale).toBeGreaterThan(0)
  })
})

describe('defaults', () => {
  it('hangs a truss and stands a floor package on the deck', () => {
    expect(DEFAULT_TRIM.truss).toBeGreaterThan(0)
    expect(DEFAULT_TRIM.floor).toBe(0)
  })

  it('pivots on the middle of the rig, half way up it', () => {
    const pivot = plotPivot([position({ x: -4, z: 8 }), position({ x: 4, z: 4 })])
    expect(pivot.x).toBe(0)
    expect(pivot.z).toBe(4)
  })

  it('has somewhere to look when the plot is empty', () => {
    expect(plotPivot([])).toEqual({ x: 0, y: 4, z: 3 })
  })
})
