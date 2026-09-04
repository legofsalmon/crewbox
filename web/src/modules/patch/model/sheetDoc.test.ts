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
  initSheet(doc, {
    title: 'Test Show',
    date: '2026-07-23',
    now: '2026-07-23T10:00:00.000Z',
  })
  // A sheet no longer seeds an act — the running order is the whole event's
  // (see `initSheet`) — so a test that needs a column puts one there itself,
  // which is what the lineup does.
  addAct(events, {
    name: 'Act 1',
    stage: 'Test Show',
    date: '2026-07-23',
    start: '19:00',
    end: '20:00',
  })
  return { doc, events }
}

/** The act these tests put on the running order for the sheet to show. */
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

  it('writes nothing to the running order', () => {
    /**
     * It used to seed an "Act 1", on the reasoning that a sheet with no acts
     * is a grid with no columns. But the running order is the whole event's —
     * the schedule module reads it, so does the countdown in every crew
     * member's sidebar, so does the production desk over the control API — so
     * making a patch sheet was adding a band called "Act 1" to the festival,
     * on a stage nobody had booked, in front of everyone. Renaming the stage
     * then dragged the placeholder onto a real one, and deleting the sheet
     * left it there for good: the act was never the sheet's to remove.
     */
    const doc = new Y.Doc()
    const events = new Y.Doc()
    initSheet(doc, { title: 'Second Stage', date: '2026-07-23' })
    expect(snapshotTimetable(events).acts).toEqual([])
  })

  it('still records the stage, which is how the sheet finds its acts', () => {
    // The stage defaults to the title. Sharing a blank one with every other
    // sheet on the box would put everybody else's acts in this grid.
    const doc = new Y.Doc()
    initSheet(doc, { title: 'Second Stage', date: '2026-07-23' })
    expect(snapshotSheet(doc).meta.stage).toBe('Second Stage')
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
    initSheet(audio, { title: 'Main Audio' })
    initSheet(lighting, { title: 'Main LX' })
    const act = addAct(events, { name: 'The Band', stage: 'Main Audio' })

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

  it('clears channels the source leaves empty, rather than merging', () => {
    // The button says "copy from the act before", and what an engineer means
    // by that is "this act is on the same rig". Skipping the empty channels
    // left a support band's four-channel patch sitting on top of the
    // headliner's thirty-six, which looks like a rig nobody ever patched.
    const { doc, events } = newSheet()
    const snap = snapshotSheet(doc)
    const source = firstAct(events)
    const target = addAct(events, { name: 'Headliner' })
    const channelA = snap.channels[0].id
    const channelB = snap.channels[1].id

    setPatchField(doc, target, channelA, 'input', 'Kick')
    setPatchField(doc, target, channelB, 'input', 'Snare')
    // The source has one channel patched and nothing on the other.
    setPatchField(doc, source, channelA, 'input', 'Vocals')

    copyPatchesFromAct(doc, source, target)
    const after = snapshotSheet(doc)
    expect(after.patches[patchKey(target, channelA)].input).toBe('Vocals')
    expect(after.patches[patchKey(target, channelB)]).toBeUndefined()
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
