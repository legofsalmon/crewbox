import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addChannel,
  clearActFromSheet,
  createSheetUndoManager,
  initSheet,
  setActExtra,
  setPatchField,
  snapshotSheet,
} from './sheetDoc'
import { patchKey } from './types'
import { addAct, snapshotTimetable } from '../../../shell/timetable/model.ts'

const newSheet = () => {
  const doc = new Y.Doc()
  const events = new Y.Doc()
  initSheet(doc, {
    title: 'Undo Show',
    date: '2026-07-24',
    now: '2026-07-24T10:00:00.000Z',
  })
  addAct(events, { name: 'Act 1', stage: 'Undo Show', date: '2026-07-24' })
  return { doc, act: snapshotTimetable(events).acts[0]!.id }
}

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

describe('sheet undo/redo', () => {
  it('undoes and redoes a cell edit', () => {
    const { doc, act } = newSheet()
    const undoManager = createSheetUndoManager(doc)
    const snap = snapshotSheet(doc)
    const channel = snap.channels[0].id

    setPatchField(doc, act, channel, 'input', 'Vocals')
    expect(snapshotSheet(doc).patches[patchKey(act, channel)].input).toBe('Vocals')

    undoManager.undo()
    expect(snapshotSheet(doc).patches[patchKey(act, channel)]).toBeUndefined()

    undoManager.redo()
    expect(snapshotSheet(doc).patches[patchKey(act, channel)].input).toBe('Vocals')
  })

  it('treats edits separated by stopCapturing as separate steps', () => {
    const { doc, act } = newSheet()
    const undoManager = createSheetUndoManager(doc)
    const snap = snapshotSheet(doc)
    const [ch1, ch2] = [snap.channels[0].id, snap.channels[1].id]

    setPatchField(doc, act, ch1, 'input', 'Kick')
    undoManager.stopCapturing()
    setPatchField(doc, act, ch2, 'input', 'Snare')

    undoManager.undo()
    let patches = snapshotSheet(doc).patches
    expect(patches[patchKey(act, ch1)].input).toBe('Kick')
    expect(patches[patchKey(act, ch2)]).toBeUndefined()

    undoManager.undo()
    patches = snapshotSheet(doc).patches
    expect(patches[patchKey(act, ch1)]).toBeUndefined()
  })

  it('undoes structural changes (add channel, drop what a sheet holds on an act)', () => {
    const { doc, act } = newSheet()
    const undoManager = createSheetUndoManager(doc)

    addChannel(doc)
    expect(snapshotSheet(doc).channels).toHaveLength(11)
    undoManager.undo()
    expect(snapshotSheet(doc).channels).toHaveLength(10)
    undoManager.redo()
    expect(snapshotSheet(doc).channels).toHaveLength(11)

    undoManager.stopCapturing()
    setActExtra(doc, act, 'spec', 'own desk')
    undoManager.stopCapturing()
    clearActFromSheet(doc, act)
    expect(snapshotSheet(doc).extras[act]).toBeUndefined()
    undoManager.undo()
    expect(snapshotSheet(doc).extras[act]?.spec).toBe('own desk')
  })

  it('never undoes remote edits, and local undo leaves remote edits intact', () => {
    const { doc: a, act } = newSheet()
    const b = new Y.Doc()
    sync(a, b)
    const undoA = createSheetUndoManager(a)
    const snap = snapshotSheet(a)
    const [ch1, ch2] = [snap.channels[0].id, snap.channels[1].id]

    // Remote-only change: B edits, A receives it via sync.
    setPatchField(b, act, ch1, 'input', 'From B')
    sync(a, b)
    expect(snapshotSheet(a).patches[patchKey(act, ch1)].input).toBe('From B')
    expect(undoA.undoStack).toHaveLength(0)
    undoA.undo() // no-op
    expect(snapshotSheet(a).patches[patchKey(act, ch1)].input).toBe('From B')

    // Interleaved: A's local edit is undone; B's remote edit survives.
    setPatchField(a, act, ch2, 'micDi', 'SM58 local')
    expect(undoA.undoStack).toHaveLength(1)
    undoA.undo()
    const after = snapshotSheet(a)
    expect(after.patches[patchKey(act, ch2)]).toBeUndefined()
    expect(after.patches[patchKey(act, ch1)].input).toBe('From B')

    // The undo itself syncs to B like any other change.
    sync(a, b)
    expect(snapshotSheet(b).patches[patchKey(act, ch2)]).toBeUndefined()
    expect(snapshotSheet(b).patches[patchKey(act, ch1)].input).toBe('From B')
  })
})
