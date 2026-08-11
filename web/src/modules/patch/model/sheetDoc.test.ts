import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addActFile,
  addChannel,
  addSubBox,
  clearActFromSheet,
  createSheetUndoManager,
  getSheetRoots,
  removeActFile,
  copyPatchesFromAct,
  initSheet,
  removeChannel,
  removeSubBox,
  renameChannel,
  setActExtra,
  setMetaField,
  setPatchField,
  setPatchSubBox,
  snapshotSheet,
  patchSubBoxDisplay,
  updateSubBox,
} from './sheetDoc'
import { patchKey } from './types'
import { addAct, snapshotTimetable } from '../../../shell/timetable/model.ts'

/**
 * A sheet and the event it belongs to.
 *
 * Two documents, because that is what a sheet is now: the acts live on the
 * shell's running order and the patch lives here. Every test that needs an
 * act asks the timetable for one.
 */
const newSheet = () => {
  const doc = new Y.Doc()
  const events = new Y.Doc()
  initSheet(doc, events, {
    title: 'Test Show',
    date: '2026-07-23',
    now: '2026-07-23T10:00:00.000Z',
  })
  return { doc, events }
}

/** The first act `initSheet` put on the running order. */
const firstAct = (events: Y.Doc) => snapshotTimetable(events).acts[0]!.id

/** Exchange updates both ways so two docs converge. */
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

describe('initSheet', () => {
  it('creates default channels and metadata, and holds no acts of its own', () => {
    const { doc } = newSheet()
    const snap = snapshotSheet(doc)
    expect(snap.meta.title).toBe('Test Show')
    expect(snap.meta.date).toBe('2026-07-23')
    expect(snap.channels).toHaveLength(10)
    expect(snap.channels[0].label).toBe('1')
    expect(snap.subBoxes).toHaveLength(0)
    // Nothing about who is on: that is the event's, not the sheet's.
    expect(snap.extras).toEqual({})
  })

  it('puts the sheet first act on the running order, under the sheet stage', () => {
    // A sheet with no acts is a grid with no columns, and the first thing
    // anyone does with a new sheet is patch somebody.
    const { events } = newSheet()
    const [act] = snapshotTimetable(events).acts
    expect(act?.name).toBe('Act 1')
    expect(act?.start).toBe('19:00')
    // The stage defaults to the title, because the stage is how the sheet
    // finds its acts again — sharing a blank one with every other sheet on
    // the box would put everybody else's acts in this grid.
    expect(act?.stage).toBe('Test Show')
    expect(act?.date).toBe('2026-07-23')
  })
})

describe('channels', () => {
  it('adds a channel at the end and after a given channel', () => {
    const { doc } = newSheet()
    const endId = addChannel(doc)
    let snap = snapshotSheet(doc)
    expect(snap.channels).toHaveLength(11)
    expect(snap.channels[10].id).toBe(endId)

    const afterId = addChannel(doc, snap.channels[2].id)
    snap = snapshotSheet(doc)
    expect(snap.channels).toHaveLength(12)
    expect(snap.channels[3].id).toBe(afterId)
  })

  it('renames a channel', () => {
    const { doc } = newSheet()
    const id = snapshotSheet(doc).channels[0].id
    renameChannel(doc, id, 'Kick')
    expect(snapshotSheet(doc).channels[0].label).toBe('Kick')
  })

  it('removing a channel removes every act patch for it', () => {
    const { doc, events } = newSheet()
    const snap = snapshotSheet(doc)
    const act = firstAct(events)
    const channel = snap.channels[0].id
    const otherChannel = snap.channels[1].id
    setPatchField(doc, act, channel, 'input', 'Vocals')
    setPatchField(doc, act, otherChannel, 'input', 'Guitar')

    removeChannel(doc, channel)
    const after = snapshotSheet(doc)
    expect(after.channels).toHaveLength(9)
    expect(after.patches[patchKey(act, channel)]).toBeUndefined()
    expect(after.patches[patchKey(act, otherChannel)].input).toBe('Guitar')
  })
})

describe('what a sheet keeps about an act', () => {
  it('keeps the spec and notes against the act id, not a copy of the act', () => {
    const { doc, events } = newSheet()
    const act = firstAct(events)
    setActExtra(doc, act, 'spec', '5 piece, own desk')
    setActExtra(doc, act, 'notes', 'needs 3 57s from house')

    const held = snapshotSheet(doc).extras[act]
    expect(held).toMatchObject({
      actId: act,
      spec: '5 piece, own desk',
      notes: 'needs 3 57s from house',
    })
    // And nothing that belongs to the running order has been duplicated here.
    expect(Object.keys(held!)).toEqual(['actId', 'spec', 'notes', 'files'])
  })

  it('lets two sheets say different things about the same act', () => {
    // The reason the spec is not on the act: an audio sheet and a lighting
    // sheet ask the same band different questions, and neither answer should
    // overwrite the other.
    const audio = new Y.Doc()
    const lighting = new Y.Doc()
    const events = new Y.Doc()
    initSheet(audio, events, { title: 'Main Audio' })
    initSheet(lighting, events, { title: 'Main LX' })
    const act = firstAct(events)

    setActExtra(audio, act, 'spec', '24 inputs')
    setActExtra(lighting, act, 'spec', 'no strobes')

    expect(snapshotSheet(audio).extras[act]?.spec).toBe('24 inputs')
    expect(snapshotSheet(lighting).extras[act]?.spec).toBe('no strobes')
  })

  it('clears its own half when an act leaves the running order', () => {
    const { doc, events } = newSheet()
    const act = firstAct(events)
    const channel = snapshotSheet(doc).channels[0].id
    setPatchField(doc, act, channel, 'input', 'Bass')
    setActExtra(doc, act, 'notes', 'gone')
    addActFile(doc, act, { id: 'f1', name: 'r.pdf', type: 'application/pdf', size: 1 })

    clearActFromSheet(doc, act)
    const after = snapshotSheet(doc)
    expect(after.extras[act]).toBeUndefined()
    expect(after.patches[patchKey(act, channel)]).toBeUndefined()
  })

  it('leaves a second act alone when the first is cleared', () => {
    const { doc, events } = newSheet()
    const first = firstAct(events)
    const second = addAct(events, { name: 'Headliner' })
    const channel = snapshotSheet(doc).channels[0].id
    setPatchField(doc, first, channel, 'input', 'gone')
    setPatchField(doc, second, channel, 'input', 'stays')

    clearActFromSheet(doc, first)
    expect(snapshotSheet(doc).patches[patchKey(second, channel)].input).toBe('stays')
  })
})

describe('sub-boxes and patch references', () => {
  it('resolves typed text to a sub-box reference by name or display name', () => {
    const { doc, events } = newSheet()
    const snap = snapshotSheet(doc)
    const act = firstAct(events)
    const channel = snap.channels[0].id
    const boxId = addSubBox(doc, { name: 'Box 1', stagePosition: 'MSC', color: '#00ff00' })

    setPatchSubBox(doc, act, channel, 'box 1')
    let entry = snapshotSheet(doc).patches[patchKey(act, channel)]
    expect(entry.subBoxId).toBe(boxId)
    expect(entry.subBoxText).toBe('')

    setPatchSubBox(doc, act, channel, 'Box 1 (MSC)')
    entry = snapshotSheet(doc).patches[patchKey(act, channel)]
    expect(entry.subBoxId).toBe(boxId)

    setPatchSubBox(doc, act, channel, 'Custom DI')
    entry = snapshotSheet(doc).patches[patchKey(act, channel)]
    expect(entry.subBoxId).toBeNull()
    expect(entry.subBoxText).toBe('Custom DI')
  })

  it('renaming a sub-box updates every referencing cell display', () => {
    const { doc, events } = newSheet()
    const snap = snapshotSheet(doc)
    const act = firstAct(events)
    const channel = snap.channels[0].id
    const boxId = addSubBox(doc, { name: 'Box 1', stagePosition: 'MSC' })
    setPatchSubBox(doc, act, channel, 'Box 1')

    updateSubBox(doc, boxId, { name: 'Stage Left Box', stagePosition: 'DSL' })
    const after = snapshotSheet(doc)
    const entry = after.patches[patchKey(act, channel)]
    expect(patchSubBoxDisplay(entry, after.subBoxes)).toBe('Stage Left Box (DSL)')
  })

  it('removing a sub-box converts references to free text', () => {
    const { doc, events } = newSheet()
    const snap = snapshotSheet(doc)
    const act = firstAct(events)
    const channel = snap.channels[0].id
    const boxId = addSubBox(doc, { name: 'Box 1', stagePosition: 'MSC' })
    setPatchSubBox(doc, act, channel, 'Box 1')

    removeSubBox(doc, boxId)
    const after = snapshotSheet(doc)
    const entry = after.patches[patchKey(act, channel)]
    expect(after.subBoxes).toHaveLength(0)
    expect(entry.subBoxId).toBeNull()
    expect(entry.subBoxText).toBe('Box 1 (MSC)')
    expect(patchSubBoxDisplay(entry, after.subBoxes)).toBe('Box 1 (MSC)')
  })
})

describe('act files', () => {
  it('adds and removes file metadata', () => {
    const { doc, events } = newSheet()
    const act = firstAct(events)
    addActFile(doc, act, { id: 'f1', name: 'rider.pdf', type: 'application/pdf', size: 1234 })
    addActFile(doc, act, { id: 'f2', name: 'stage.png', type: 'image/png', size: 999 })

    let files = snapshotSheet(doc).extras[act]!.files
    expect(files.map((f) => f.name).sort()).toEqual(['rider.pdf', 'stage.png'])

    removeActFile(doc, act, 'f1')
    files = snapshotSheet(doc).extras[act]!.files
    expect(files.map((f) => f.id)).toEqual(['f2'])
  })

  it('merges concurrent file additions from two devices', () => {
    // Two people on a stage both dropping a rider on the same act is an
    // ordinary Saturday. Keyed by file rather than kept in one list per act,
    // so neither write is the whole container and neither is lost.
    const { doc: a, events } = newSheet()
    const b = new Y.Doc()
    sync(a, b)
    const act = firstAct(events)

    addActFile(a, act, { id: 'fa', name: 'from-a.pdf', type: 'application/pdf', size: 1 })
    addActFile(b, act, { id: 'fb', name: 'from-b.png', type: 'image/png', size: 2 })
    sync(a, b)

    for (const doc of [a, b]) {
      const ids = snapshotSheet(doc)
        .extras[act]!.files.map((f) => f.id)
        .sort()
      expect(ids).toEqual(['fa', 'fb'])
    }
  })

  it('merges concurrent first-attachments, spec and file, on the same act', () => {
    // The pair that a lazily-created nested container loses: both devices
    // touch an act nothing has been said about yet.
    const { doc: a, events } = newSheet()
    const b = new Y.Doc()
    sync(a, b)
    const act = firstAct(events)

    setActExtra(a, act, 'spec', 'from A')
    addActFile(b, act, { id: 'fb', name: 'from-b.png', type: 'image/png', size: 2 })
    sync(a, b)

    for (const doc of [a, b]) {
      const held = snapshotSheet(doc).extras[act]!
      expect(held.spec).toBe('from A')
      expect(held.files.map((f) => f.id)).toEqual(['fb'])
    }
  })
})

describe('copyPatchesFromAct', () => {
  it('copies all channel entries onto the target act', () => {
    const { doc, events } = newSheet()
    const snap = snapshotSheet(doc)
    const source = firstAct(events)
    const channelA = snap.channels[0].id
    const channelB = snap.channels[1].id
    setPatchField(doc, source, channelA, 'input', 'Vocals')
    setPatchField(doc, source, channelB, 'micDi', 'SM58')

    const target = addAct(events, { name: 'Next up' })
    copyPatchesFromAct(doc, source, target)
    const after = snapshotSheet(doc)
    expect(after.patches[patchKey(target, channelA)].input).toBe('Vocals')
    expect(after.patches[patchKey(target, channelB)].micDi).toBe('SM58')
  })
})

describe('concurrent editing (the scenarios v1 loses data on)', () => {
  it('merges concurrent edits to different cells from two offline devices', () => {
    const { doc: a, events } = newSheet()
    const b = new Y.Doc()
    sync(a, b)

    const snap = snapshotSheet(a)
    const act = firstAct(events)
    const [ch1, ch2] = [snap.channels[0].id, snap.channels[1].id]

    // Both devices edit while disconnected from each other.
    setPatchField(a, act, ch1, 'input', 'Vocals from A')
    setPatchField(b, act, ch2, 'input', 'Guitar from B')
    setMetaField(b, 'stage', 'Main Stage')

    sync(a, b)

    for (const doc of [a, b]) {
      const merged = snapshotSheet(doc)
      expect(merged.patches[patchKey(act, ch1)].input).toBe('Vocals from A')
      expect(merged.patches[patchKey(act, ch2)].input).toBe('Guitar from B')
      expect(merged.meta.stage).toBe('Main Stage')
    }
  })

  it('merges a concurrent channel insert and cell edit without losing either', () => {
    const { doc: a, events } = newSheet()
    const b = new Y.Doc()
    sync(a, b)

    const snap = snapshotSheet(a)
    const act = firstAct(events)
    const ch5 = snap.channels[4].id

    addChannel(a, snap.channels[1].id) // A inserts a channel near the top
    setPatchField(b, act, ch5, 'description', 'Kick Drum') // B edits channel 5

    sync(a, b)

    for (const doc of [a, b]) {
      const merged = snapshotSheet(doc)
      expect(merged.channels).toHaveLength(11)
      // B's edit still belongs to the same channel row, wherever it now sits.
      expect(merged.patches[patchKey(act, ch5)].description).toBe('Kick Drum')
      const rowIndex = merged.channels.findIndex((c) => c.id === ch5)
      expect(rowIndex).toBeGreaterThanOrEqual(0)
    }
  })

  it('converges when both devices edit the same cell', () => {
    const { doc: a, events } = newSheet()
    const b = new Y.Doc()
    sync(a, b)

    const snap = snapshotSheet(a)
    const act = firstAct(events)
    const ch = snap.channels[0].id
    setPatchField(a, act, ch, 'input', 'From A')
    setPatchField(b, act, ch, 'input', 'From B')

    sync(a, b)

    const valueA = snapshotSheet(a).patches[patchKey(act, ch)].input
    const valueB = snapshotSheet(b).patches[patchKey(act, ch)].input
    expect(valueA).toBe(valueB)
    expect(['From A', 'From B']).toContain(valueA)
  })
})

/**
 * A channel number is a desk input number. The row below channel 3 is
 * channel 4, and it stays channel 4 when something is inserted above it —
 * which is the whole reason the "Insert channel below" button exists.
 *
 * It did not do that. `addChannel` labelled the new row by the channel
 * *count* rather than its position, so inserting below 3 of 10 produced
 * 1,2,3,11,4,5… and deleting a middle row then appending produced two rows
 * both called 10.
 */
describe('channel numbers follow position', () => {
  const tenChannels = () => {
    const { doc } = newSheet()
    const { channels } = getSheetRoots(doc)
    while (channels.length < 10) addChannel(doc)
    return doc
  }
  const labels = (doc: Y.Doc) => snapshotSheet(doc).channels.map((c) => c.label)

  it('renumbers everything below an insert', () => {
    const doc = tenChannels()
    addChannel(doc, snapshotSheet(doc).channels[2].id)
    expect(labels(doc)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
  })

  it('closes the gap when a channel is removed', () => {
    const doc = tenChannels()
    removeChannel(doc, snapshotSheet(doc).channels[4].id)
    expect(labels(doc)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
  })

  it('never leaves two channels with the same number', () => {
    const doc = tenChannels()
    removeChannel(doc, snapshotSheet(doc).channels[4].id)
    addChannel(doc)
    const all = labels(doc)
    expect(new Set(all).size).toBe(all.length)
    expect(all[all.length - 1]).toBe('10')
  })

  it('leaves hand-typed names alone, and numbers step over them', () => {
    const doc = tenChannels()
    const before = snapshotSheet(doc).channels
    renameChannel(doc, before[2].id, 'SUB L')
    // Insert at the very top: everything numeric shifts, "SUB L" does not.
    addChannel(doc, before[0].id)
    expect(labels(doc)).toEqual(['1', '2', '3', 'SUB L', '5', '6', '7', '8', '9', '10', '11'])
  })

  it('an insert and its renumbering undo as one step', () => {
    const doc = tenChannels()
    const undo = createSheetUndoManager(doc)
    addChannel(doc, snapshotSheet(doc).channels[2].id)
    expect(labels(doc)).toHaveLength(11)
    undo.undo()
    expect(labels(doc)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
  })
})
