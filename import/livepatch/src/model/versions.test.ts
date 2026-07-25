import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addChannel,
  addSubBox,
  createSheetUndoManager,
  initSheet,
  patchSubBoxDisplay,
  setPatchField,
  setPatchSubBox,
  snapshotSheet,
  updateArtist,
} from './sheetDoc'
import {
  deleteVersion,
  listVersions,
  restoreVersion,
  saveVersion,
  versionSnapshot,
} from './versions'
import { patchKey } from './types'

const newSheet = () => {
  const doc = new Y.Doc()
  initSheet(doc, { title: 'Versions Show', date: '2026-07-25', now: '2026-07-25T10:00:00.000Z' })
  return doc
}

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

describe('sheet versions', () => {
  it('saves named versions and lists them newest first', () => {
    const doc = newSheet()
    saveVersion(doc, 'first', '2026-07-25T10:00:00.000Z')
    saveVersion(doc, '  ', '2026-07-25T11:00:00.000Z')
    const versions = listVersions(doc)
    expect(versions.map((v) => v.name)).toEqual(['Untitled version', 'first'])
    expect(versionSnapshot(versions[1]).meta.title).toBe('Versions Show')
  })

  it('restores the sheet to exactly the saved state', () => {
    const doc = newSheet()
    const snap0 = snapshotSheet(doc)
    const artist = snap0.artists[0].id
    const channel = snap0.channels[0].id
    addSubBox(doc, { name: 'Box A', stagePosition: 'DSL' })
    setPatchSubBox(doc, artist, channel, 'Box A')
    setPatchField(doc, artist, channel, 'input', 'Kick')
    const saved = saveVersion(doc, 'after soundcheck')

    // Diverge in every root: cells, structure, artist, meta.
    setPatchField(doc, artist, channel, 'input', 'Kick REPLACED')
    addChannel(doc)
    updateArtist(doc, artist, { name: 'Renamed' })

    expect(restoreVersion(doc, saved.id)).toBe(true)
    const after = snapshotSheet(doc)
    expect(after).toEqual(versionSnapshot(saved))
    // Sub-box reference (not just text) survives the round trip.
    const entry = after.patches[patchKey(artist, channel)]
    expect(entry.subBoxId).not.toBeNull()
    expect(patchSubBoxDisplay(entry, after.subBoxes)).toBe('Box A (DSL)')
  })

  it('restore is a single undo step; saving adds none', () => {
    const doc = newSheet()
    const undoManager = createSheetUndoManager(doc)
    const snap0 = snapshotSheet(doc)
    const artist = snap0.artists[0].id
    const channel = snap0.channels[0].id

    setPatchField(doc, artist, channel, 'input', 'A')
    undoManager.stopCapturing()
    const saved = saveVersion(doc, 'v1')
    expect(undoManager.undoStack).toHaveLength(1)

    setPatchField(doc, artist, channel, 'input', 'B')
    undoManager.stopCapturing()
    restoreVersion(doc, saved.id)
    expect(snapshotSheet(doc).patches[patchKey(artist, channel)].input).toBe('A')

    undoManager.undo()
    expect(snapshotSheet(doc).patches[patchKey(artist, channel)].input).toBe('B')
    undoManager.redo()
    expect(snapshotSheet(doc).patches[patchKey(artist, channel)].input).toBe('A')
    // Undoing the restore never touches the saved versions.
    expect(listVersions(doc)).toHaveLength(1)
  })

  it('deletes versions and reports a missing id on restore', () => {
    const doc = newSheet()
    const saved = saveVersion(doc, 'gone soon')
    deleteVersion(doc, saved.id)
    expect(listVersions(doc)).toHaveLength(0)
    expect(restoreVersion(doc, saved.id)).toBe(false)
  })

  it('concurrent saves on two devices merge as two entries', () => {
    const a = newSheet()
    const b = new Y.Doc()
    sync(a, b)
    saveVersion(a, 'from A', '2026-07-25T12:00:00.000Z')
    saveVersion(b, 'from B', '2026-07-25T12:00:01.000Z')
    sync(a, b)
    expect(listVersions(a).map((v) => v.name)).toEqual(['from B', 'from A'])
    expect(listVersions(b)).toHaveLength(2)
  })
})
