import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addFixture,
  addFixtures,
  addPosition,
  addressSequentially,
  createPlotUndoManager,
  fixturesOnPosition,
  initPlot,
  removeFixture,
  removePosition,
  setFixtureStatus,
  snapshotPlot,
  updateFixture,
  updatePosition,
} from './plotDoc'

const newPlot = (title = 'Main Stage') => {
  const doc = new Y.Doc()
  initPlot(doc, { title, venue: 'Worthy Farm', date: '2026-06-24' })
  return doc
}

/** Exchange updates both ways, as the relay would. */
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

describe('plot doc', () => {
  it('initialises with meta and a position to hang things on', () => {
    const plot = snapshotPlot(newPlot())
    expect(plot.meta).toMatchObject({ title: 'Main Stage', venue: 'Worthy Farm' })
    expect(plot.positions).toHaveLength(1)
    expect(plot.fixtures).toHaveLength(0)
  })

  it('adds, updates and removes fixtures', () => {
    const doc = newPlot()
    const id = addFixture(doc, { channel: '101', universe: 1, address: 1, footprint: 16 })

    expect(snapshotPlot(doc).fixtures[0]).toMatchObject({ channel: '101', address: 1 })

    updateFixture(doc, id, { purpose: 'DS Wash' })
    expect(snapshotPlot(doc).fixtures[0]!.purpose).toBe('DS Wash')

    setFixtureStatus(doc, id, 'fault')
    expect(snapshotPlot(doc).fixtures[0]!.status).toBe('fault')

    removeFixture(doc, id)
    expect(snapshotPlot(doc).fixtures).toHaveLength(0)
  })

  it('keeps fixtures when their position is removed', () => {
    // A truss coming out of the rig doesn't mean its fixtures stopped
    // existing — they drop to unassigned so nobody loses their patch.
    const doc = newPlot()
    const positionId = addPosition(doc, 'SL Boom', 'boom')
    const fixtureId = addFixture(doc, { positionId, purpose: 'Side light' })

    removePosition(doc, positionId)

    const plot = snapshotPlot(doc)
    expect(plot.positions.some((p) => p.id === positionId)).toBe(false)
    expect(plot.fixtures).toHaveLength(1)
    expect(plot.fixtures[0]).toMatchObject({ id: fixtureId, positionId: '', purpose: 'Side light' })
  })

  it('addresses a run of fixtures nose to tail by footprint', () => {
    const doc = newPlot()
    const ids = addFixtures(doc, [{ footprint: 16 }, { footprint: 16 }, { footprint: 24 }])

    addressSequentially(doc, ids, 2, 1)

    expect(snapshotPlot(doc).fixtures.map((f) => [f.universe, f.address])).toEqual([
      [2, 1],
      [2, 17],
      [2, 33],
    ])
  })

  it('orders fixtures along a position numerically, not lexically', () => {
    const doc = newPlot()
    const positionId = addPosition(doc, 'Truss 1')
    addFixtures(doc, [
      { positionId, unit: '10', purpose: 'ten' },
      { positionId, unit: '2', purpose: 'two' },
      { positionId, unit: '1', purpose: 'one' },
    ])

    // '10' sorts before '2' as a string; on a truss it hangs after it.
    expect(fixturesOnPosition(snapshotPlot(doc), positionId).map((f) => f.purpose)).toEqual([
      'one',
      'two',
      'ten',
    ])
  })

  it('reads a doc missing newer fields without crashing', () => {
    // A peer on an older build sends a fixture with only some fields set.
    const doc = new Y.Doc()
    const fixtures = doc.getArray<Y.Map<unknown>>('fixtures')
    const partial = new Y.Map<unknown>()
    partial.set('id', 'legacy')
    partial.set('channel', '5')
    fixtures.push([partial])

    const plot = snapshotPlot(doc)
    expect(plot.fixtures[0]).toMatchObject({
      id: 'legacy',
      channel: '5',
      status: 'todo',
      footprint: 1,
      watts: null,
    })
  })
})

describe('plot doc collaboration', () => {
  it('merges fixtures added on two devices at once', () => {
    const a = newPlot()
    const b = new Y.Doc()
    sync(a, b)

    addFixture(a, { channel: '1', purpose: 'from A' })
    addFixture(b, { channel: '2', purpose: 'from B' })
    sync(a, b)

    for (const doc of [a, b]) {
      const purposes = snapshotPlot(doc)
        .fixtures.map((f) => f.purpose)
        .sort()
      expect(purposes).toEqual(['from A', 'from B'])
    }
  })

  it('merges two people editing different fields of one fixture', () => {
    const a = newPlot()
    const b = new Y.Doc()
    const id = addFixture(a, {})
    sync(a, b)

    // One person is addressing while the other is labelling.
    updateFixture(a, id, { address: 100, universe: 2 })
    updateFixture(b, id, { purpose: 'Key light' })
    sync(a, b)

    for (const doc of [a, b]) {
      expect(snapshotPlot(doc).fixtures[0]).toMatchObject({
        address: 100,
        universe: 2,
        purpose: 'Key light',
      })
    }
  })

  it('never undoes the other device’s edit', () => {
    const a = newPlot()
    const b = new Y.Doc()
    const id = addFixture(a, {})
    sync(a, b)

    const undoA = createPlotUndoManager(a)
    updateFixture(a, id, { purpose: 'Mine' })
    sync(a, b)
    updateFixture(b, id, { circuit: 'Theirs' })
    sync(a, b)

    undoA.undo()
    sync(a, b)

    // A's own edit is gone; B's survives.
    expect(snapshotPlot(a).fixtures[0]).toMatchObject({ purpose: '', circuit: 'Theirs' })
    expect(snapshotPlot(b).fixtures[0]).toMatchObject({ purpose: '', circuit: 'Theirs' })
  })

  it('undoes a bulk address as one step', () => {
    const doc = newPlot()
    const ids = addFixtures(doc, [{ footprint: 16 }, { footprint: 16 }])
    const undo = createPlotUndoManager(doc)

    addressSequentially(doc, ids, 1, 100)
    expect(snapshotPlot(doc).fixtures.map((f) => f.address)).toEqual([100, 116])

    undo.undo()
    expect(snapshotPlot(doc).fixtures.map((f) => f.address)).toEqual([0, 0])
  })
})

describe('positions', () => {
  it('places new positions upstage of each other rather than stacking them', () => {
    const doc = newPlot()
    addPosition(doc, 'Truss 2')
    const ys = snapshotPlot(doc).positions.map((p) => p.y)
    expect(new Set(ys).size).toBe(ys.length)
  })

  it('moves a position in the plot', () => {
    const doc = newPlot()
    const id = addPosition(doc, 'Truss 2')
    updatePosition(doc, id, { x: 3, y: 8, rotation: 90, length: 6 })
    const position = snapshotPlot(doc).positions.find((p) => p.id === id)
    expect(position).toMatchObject({ x: 3, y: 8, rotation: 90, length: 6 })
  })
})
