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
  upsertFixtureType,
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

describe('fixture types', () => {
  it('keeps a caller-owned id so imported fixtures still resolve', () => {
    // MVR keys types by GDTF filename and its fixtures reference that same
    // string; minting a fresh id would leave every one pointing at nothing.
    const doc = newPlot()
    upsertFixtureType(doc, {
      id: 'Clay Paky@Sharpy@v1.gdtf',
      name: 'Clay Paky Sharpy',
      modes: [{ name: 'Standard', footprint: 16 }],
    })
    addFixture(doc, { typeId: 'Clay Paky@Sharpy@v1.gdtf' })

    const plot = snapshotPlot(doc)
    expect(plot.customTypes[0]!.id).toBe('Clay Paky@Sharpy@v1.gdtf')
    expect(plot.customTypes.some((type) => type.id === plot.fixtures[0]!.typeId)).toBe(true)
  })

  it('replaces rather than duplicates on a second import', () => {
    const doc = newPlot()
    const type = { id: 'spec.gdtf', name: 'Head', modes: [{ name: 'A', footprint: 8 }] }
    upsertFixtureType(doc, type)
    upsertFixtureType(doc, { ...type, modes: [{ name: 'A', footprint: 12 }] })

    const types = snapshotPlot(doc).customTypes
    expect(types).toHaveLength(1)
    expect(types[0]!.modes[0]!.footprint).toBe(12)
  })

  it('round-trips a GDTF channel map through the document', () => {
    // The channel map is the deepest thing the plot stores, and it is what
    // the live view reads to say "the dimmer is at 60%" rather than "the
    // highest of these sixteen channels is 153". If it doesn't survive the
    // CRDT it degrades silently.
    const doc = newPlot()
    upsertFixtureType(doc, {
      id: 'head.gdtf',
      name: 'Head',
      weight: 21.5,
      beamAngle: 14,
      modes: [
        {
          name: 'Standard',
          footprint: 3,
          channels: [
            {
              offsets: [1, 2],
              attribute: 'Pan',
              geometry: 'Yoke',
              dmxBreak: 1,
              unit: '°',
              functions: [{ name: 'Pan', from: 0, physicalFrom: -270, physicalTo: 270 }],
            },
            {
              offsets: [3],
              attribute: 'Color1',
              geometry: 'Head',
              dmxBreak: 1,
              unit: '',
              slots: [{ from: 10, name: 'Red', colour: '#ff0000' }],
            },
          ],
        },
      ],
    })

    const type = snapshotPlot(doc).customTypes[0]!
    expect(type).toMatchObject({ weight: 21.5, beamAngle: 14 })
    expect(type.modes[0]!.channels).toEqual([
      {
        offsets: [1, 2],
        attribute: 'Pan',
        geometry: 'Yoke',
        dmxBreak: 1,
        unit: '°',
        functions: [{ name: 'Pan', from: 0, physicalFrom: -270, physicalTo: 270 }],
      },
      {
        offsets: [3],
        attribute: 'Color1',
        geometry: 'Head',
        dmxBreak: 1,
        unit: '',
        slots: [{ from: 10, name: 'Red', colour: '#ff0000' }],
      },
    ])
  })

  it('drops a channel it could never read rather than keeping a dead row', () => {
    // A doc can arrive from a peer on another build. A channel with no
    // offsets has nowhere on the wire to read from, and one with no
    // attribute has nothing to say — both would sit in the readout forever
    // showing nothing.
    const doc = newPlot()
    upsertFixtureType(doc, {
      id: 'odd.gdtf',
      name: 'Odd',
      modes: [
        {
          name: 'M',
          footprint: 2,
          channels: [
            { offsets: [], attribute: 'Dimmer', geometry: '', dmxBreak: 1, unit: '' },
            { offsets: [1], attribute: '', geometry: '', dmxBreak: 1, unit: '' },
            { offsets: [2], attribute: 'Dimmer', geometry: '', dmxBreak: 1, unit: '%' },
          ],
        },
      ],
    })

    const mode = snapshotPlot(doc).customTypes[0]!.modes[0]!
    expect(mode.channels).toEqual([
      { offsets: [2], attribute: 'Dimmer', geometry: '', dmxBreak: 1, unit: '%' },
    ])
    // The footprint is stored separately and stays what the profile said.
    expect(mode.footprint).toBe(2)
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
