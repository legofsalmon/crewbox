import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addChannel,
  createSheetUndoManager,
  initSheet,
  removeArtist,
  addArtist,
  setPatchField,
  snapshotSheet,
} from './sheetDoc'
import { patchKey } from './types'

const newSheet = () => {
  const doc = new Y.Doc()
  initSheet(doc, { title: 'Undo Show', date: '2026-07-24', now: '2026-07-24T10:00:00.000Z' })
  return doc
}

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

describe('sheet undo/redo', () => {
  it('undoes and redoes a cell edit', () => {
    const doc = newSheet()
    const undoManager = createSheetUndoManager(doc)
    const snap = snapshotSheet(doc)
    const artist = snap.artists[0].id
    const channel = snap.channels[0].id

    setPatchField(doc, artist, channel, 'input', 'Vocals')
    expect(snapshotSheet(doc).patches[patchKey(artist, channel)].input).toBe('Vocals')

    undoManager.undo()
    expect(snapshotSheet(doc).patches[patchKey(artist, channel)]).toBeUndefined()

    undoManager.redo()
    expect(snapshotSheet(doc).patches[patchKey(artist, channel)].input).toBe('Vocals')
  })

  it('treats edits separated by stopCapturing as separate steps', () => {
    const doc = newSheet()
    const undoManager = createSheetUndoManager(doc)
    const snap = snapshotSheet(doc)
    const artist = snap.artists[0].id
    const [ch1, ch2] = [snap.channels[0].id, snap.channels[1].id]

    setPatchField(doc, artist, ch1, 'input', 'Kick')
    undoManager.stopCapturing()
    setPatchField(doc, artist, ch2, 'input', 'Snare')

    undoManager.undo()
    let patches = snapshotSheet(doc).patches
    expect(patches[patchKey(artist, ch1)].input).toBe('Kick')
    expect(patches[patchKey(artist, ch2)]).toBeUndefined()

    undoManager.undo()
    patches = snapshotSheet(doc).patches
    expect(patches[patchKey(artist, ch1)]).toBeUndefined()
  })

  it('undoes structural changes (add channel, remove artist)', () => {
    const doc = newSheet()
    const undoManager = createSheetUndoManager(doc)

    addChannel(doc)
    expect(snapshotSheet(doc).channels).toHaveLength(11)
    undoManager.undo()
    expect(snapshotSheet(doc).channels).toHaveLength(10)
    undoManager.redo()
    expect(snapshotSheet(doc).channels).toHaveLength(11)

    undoManager.stopCapturing()
    const second = addArtist(doc)
    undoManager.stopCapturing()
    removeArtist(doc, second)
    expect(snapshotSheet(doc).artists).toHaveLength(1)
    undoManager.undo()
    expect(snapshotSheet(doc).artists).toHaveLength(2)
  })

  it('never undoes remote edits, and local undo leaves remote edits intact', () => {
    const a = newSheet()
    const b = new Y.Doc()
    sync(a, b)
    const undoA = createSheetUndoManager(a)
    const snap = snapshotSheet(a)
    const artist = snap.artists[0].id
    const [ch1, ch2] = [snap.channels[0].id, snap.channels[1].id]

    // Remote-only change: B edits, A receives it via sync.
    setPatchField(b, artist, ch1, 'input', 'From B')
    sync(a, b)
    expect(snapshotSheet(a).patches[patchKey(artist, ch1)].input).toBe('From B')
    expect(undoA.undoStack).toHaveLength(0)
    undoA.undo() // no-op
    expect(snapshotSheet(a).patches[patchKey(artist, ch1)].input).toBe('From B')

    // Interleaved: A's local edit is undone; B's remote edit survives.
    setPatchField(a, artist, ch2, 'micDi', 'SM58 local')
    expect(undoA.undoStack).toHaveLength(1)
    undoA.undo()
    const after = snapshotSheet(a)
    expect(after.patches[patchKey(artist, ch2)]).toBeUndefined()
    expect(after.patches[patchKey(artist, ch1)].input).toBe('From B')

    // The undo itself syncs to B like any other change.
    sync(a, b)
    expect(snapshotSheet(b).patches[patchKey(artist, ch2)]).toBeUndefined()
    expect(snapshotSheet(b).patches[patchKey(artist, ch1)].input).toBe('From B')
  })
})
