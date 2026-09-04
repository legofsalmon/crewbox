import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addChannel,
  addSubBox,
  createSheetUndoManager,
  initSheet,
  patchSubBoxDisplay,
  setPatchField,
  setActExtra,
  setMetaField,
  setPatchSubBox,
  snapshotSheet,
} from './sheetDoc'
import {
  deleteVersion,
  listVersions,
  restoreVersion,
  saveVersion,
  versionSnapshot,
} from './versions'
import { patchKey } from './types'
import { snapshotTimetable, updateAct } from '../../../shell/timetable/model.ts'

const newSheet = () => {
  const doc = new Y.Doc()
  const events = new Y.Doc()
  initSheet(doc, events, {
    title: 'Versions Show',
    date: '2026-07-25',
    now: '2026-07-25T10:00:00.000Z',
  })
  return { doc, events, act: snapshotTimetable(events).acts[0]!.id }
}

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

describe('sheet versions', () => {
  it('saves named versions and lists them newest first', () => {
    const { doc } = newSheet()
    saveVersion(doc, 'first', '2026-07-25T10:00:00.000Z')
    saveVersion(doc, '  ', '2026-07-25T11:00:00.000Z')
    const versions = listVersions(doc)
    expect(versions.map((v) => v.name)).toEqual(['Untitled version', 'first'])
    expect(versionSnapshot(versions[1]).meta.title).toBe('Versions Show')
  })

  it('leaves the sheet on the stage and day it is currently for', () => {
    /**
     * `stage` and `date` are not the sheet's own content — they are the join
     * to the running order, and how the sheet finds its columns. Putting an
     * old pair back while every act stayed where it is disconnects the sheet
     * from its acts, and the result is a blank grid with nothing saying why.
     *
     * The toolbar can change them, and moves the acts when it does. A
     * restore has no business doing half of that, and it is the same
     * reasoning that already stops a restore touching the running order.
     */
    const { doc } = newSheet()
    const saved = saveVersion(doc, 'before the day moved')

    setMetaField(doc, 'date', '2026-07-26')
    setMetaField(doc, 'stage', 'Second Stage')
    setMetaField(doc, 'title', 'Renamed')

    expect(restoreVersion(doc, saved.id)).toBe(true)
    const after = snapshotSheet(doc)
    // The join stays where the sheet is now.
    expect(after.meta.date).toBe('2026-07-26')
    expect(after.meta.stage).toBe('Second Stage')
    // The sheet's own content comes back, title included.
    expect(after.meta.title).toBe('Versions Show')
  })

  it('restores the sheet to exactly the saved state', () => {
    const { doc, act } = newSheet()
    const snap0 = snapshotSheet(doc)
    const channel = snap0.channels[0].id
    addSubBox(doc, { name: 'Box A', stagePosition: 'DSL' })
    setPatchSubBox(doc, act, channel, 'Box A')
    setPatchField(doc, act, channel, 'input', 'Kick')
    setActExtra(doc, act, 'spec', 'own desk')
    const saved = saveVersion(doc, 'after soundcheck')

    // Diverge in every root: cells, structure, what the sheet holds, meta.
    setPatchField(doc, act, channel, 'input', 'Kick REPLACED')
    addChannel(doc)
    setActExtra(doc, act, 'spec', 'REPLACED')

    expect(restoreVersion(doc, saved.id)).toBe(true)
    const after = snapshotSheet(doc)
    expect(after).toEqual(versionSnapshot(saved))
    expect(after.extras[act]?.spec).toBe('own desk')
    // Sub-box reference (not just text) survives the round trip.
    const entry = after.patches[patchKey(act, channel)]
    expect(entry.subBoxId).not.toBeNull()
    expect(patchSubBoxDisplay(entry, after.subBoxes)).toBe('Box A (DSL)')
  })

  it('restore is a single undo step; saving adds none', () => {
    const { doc, act } = newSheet()
    const undoManager = createSheetUndoManager(doc)
    const snap0 = snapshotSheet(doc)
    const channel = snap0.channels[0].id

    setPatchField(doc, act, channel, 'input', 'A')
    undoManager.stopCapturing()
    const saved = saveVersion(doc, 'v1')
    expect(undoManager.undoStack).toHaveLength(1)

    setPatchField(doc, act, channel, 'input', 'B')
    undoManager.stopCapturing()
    restoreVersion(doc, saved.id)
    expect(snapshotSheet(doc).patches[patchKey(act, channel)].input).toBe('A')

    undoManager.undo()
    expect(snapshotSheet(doc).patches[patchKey(act, channel)].input).toBe('B')
    undoManager.redo()
    expect(snapshotSheet(doc).patches[patchKey(act, channel)].input).toBe('A')
    // Undoing the restore never touches the saved versions.
    expect(listVersions(doc)).toHaveLength(1)
  })

  it('deletes versions and reports a missing id on restore', () => {
    const { doc } = newSheet()
    const saved = saveVersion(doc, 'gone soon')
    deleteVersion(doc, saved.id)
    expect(listVersions(doc)).toHaveLength(0)
    expect(restoreVersion(doc, saved.id)).toBe(false)
  })

  it('concurrent saves on two devices merge as two entries', () => {
    const { doc: a } = newSheet()
    const b = new Y.Doc()
    sync(a, b)
    saveVersion(a, 'from A', '2026-07-25T12:00:00.000Z')
    saveVersion(b, 'from B', '2026-07-25T12:00:01.000Z')
    sync(a, b)
    expect(listVersions(a).map((v) => v.name)).toEqual(['from B', 'from A'])
    expect(listVersions(b)).toHaveLength(2)
  })

  it('restoring a version leaves the running order alone', () => {
    // A version is a version of this sheet. Restoring one must not reach
    // across and move set times for every other department on the box.
    const { doc, events, act } = newSheet()
    const saved = saveVersion(doc, 'before the change')
    updateAct(events, act, { name: 'Renamed after the save', start: '22:30' })

    restoreVersion(doc, saved.id)
    expect(snapshotTimetable(events).acts[0]).toMatchObject({
      name: 'Renamed after the save',
      start: '22:30',
    })
  })
})
