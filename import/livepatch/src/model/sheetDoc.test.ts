import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addArtist,
  addArtistFile,
  addChannel,
  addSubBox,
  removeArtistFile,
  copyPatchesFromArtist,
  initSheet,
  removeArtist,
  removeChannel,
  removeSubBox,
  renameChannel,
  setMetaField,
  setPatchField,
  setPatchSubBox,
  snapshotSheet,
  patchSubBoxDisplay,
  updateArtist,
  updateSubBox,
} from './sheetDoc'
import { patchKey } from './types'

const newSheet = () => {
  const doc = new Y.Doc()
  initSheet(doc, { title: 'Test Show', date: '2026-07-23', now: '2026-07-23T10:00:00.000Z' })
  return doc
}

/** Exchange updates both ways so two docs converge. */
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

describe('initSheet', () => {
  it('creates default channels, one artist, and metadata', () => {
    const snap = snapshotSheet(newSheet())
    expect(snap.meta.title).toBe('Test Show')
    expect(snap.meta.date).toBe('2026-07-23')
    expect(snap.channels).toHaveLength(10)
    expect(snap.channels[0].label).toBe('1')
    expect(snap.artists).toHaveLength(1)
    expect(snap.artists[0].name).toBe('Artist 1')
    expect(snap.artists[0].startTime).toBe('19:00')
    expect(snap.subBoxes).toHaveLength(0)
  })
})

describe('channels', () => {
  it('adds a channel at the end and after a given channel', () => {
    const doc = newSheet()
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
    const doc = newSheet()
    const id = snapshotSheet(doc).channels[0].id
    renameChannel(doc, id, 'Kick')
    expect(snapshotSheet(doc).channels[0].label).toBe('Kick')
  })

  it('removing a channel removes every artist patch for it', () => {
    const doc = newSheet()
    const snap = snapshotSheet(doc)
    const artist = snap.artists[0].id
    const channel = snap.channels[0].id
    const otherChannel = snap.channels[1].id
    setPatchField(doc, artist, channel, 'input', 'Vocals')
    setPatchField(doc, artist, otherChannel, 'input', 'Guitar')

    removeChannel(doc, channel)
    const after = snapshotSheet(doc)
    expect(after.channels).toHaveLength(9)
    expect(after.patches[patchKey(artist, channel)]).toBeUndefined()
    expect(after.patches[patchKey(artist, otherChannel)].input).toBe('Guitar')
  })
})

describe('artists', () => {
  it('adds, updates, and removes artists (with their patches)', () => {
    const doc = newSheet()
    const second = addArtist(doc)
    updateArtist(doc, second, { name: 'Headliner', startTime: '21:00' })
    let snap = snapshotSheet(doc)
    expect(snap.artists).toHaveLength(2)
    expect(snap.artists[1]).toMatchObject({ name: 'Headliner', startTime: '21:00' })

    const channel = snap.channels[0].id
    setPatchField(doc, second, channel, 'input', 'Bass')
    removeArtist(doc, second)
    snap = snapshotSheet(doc)
    expect(snap.artists).toHaveLength(1)
    expect(snap.patches[patchKey(second, channel)]).toBeUndefined()
  })
})

describe('sub-boxes and patch references', () => {
  it('resolves typed text to a sub-box reference by name or display name', () => {
    const doc = newSheet()
    const snap = snapshotSheet(doc)
    const artist = snap.artists[0].id
    const channel = snap.channels[0].id
    const boxId = addSubBox(doc, { name: 'Box 1', stagePosition: 'MSC', color: '#00ff00' })

    setPatchSubBox(doc, artist, channel, 'box 1')
    let entry = snapshotSheet(doc).patches[patchKey(artist, channel)]
    expect(entry.subBoxId).toBe(boxId)
    expect(entry.subBoxText).toBe('')

    setPatchSubBox(doc, artist, channel, 'Box 1 (MSC)')
    entry = snapshotSheet(doc).patches[patchKey(artist, channel)]
    expect(entry.subBoxId).toBe(boxId)

    setPatchSubBox(doc, artist, channel, 'Custom DI')
    entry = snapshotSheet(doc).patches[patchKey(artist, channel)]
    expect(entry.subBoxId).toBeNull()
    expect(entry.subBoxText).toBe('Custom DI')
  })

  it('renaming a sub-box updates every referencing cell display', () => {
    const doc = newSheet()
    const snap = snapshotSheet(doc)
    const artist = snap.artists[0].id
    const channel = snap.channels[0].id
    const boxId = addSubBox(doc, { name: 'Box 1', stagePosition: 'MSC' })
    setPatchSubBox(doc, artist, channel, 'Box 1')

    updateSubBox(doc, boxId, { name: 'Stage Left Box', stagePosition: 'DSL' })
    const after = snapshotSheet(doc)
    const entry = after.patches[patchKey(artist, channel)]
    expect(patchSubBoxDisplay(entry, after.subBoxes)).toBe('Stage Left Box (DSL)')
  })

  it('removing a sub-box converts references to free text', () => {
    const doc = newSheet()
    const snap = snapshotSheet(doc)
    const artist = snap.artists[0].id
    const channel = snap.channels[0].id
    const boxId = addSubBox(doc, { name: 'Box 1', stagePosition: 'MSC' })
    setPatchSubBox(doc, artist, channel, 'Box 1')

    removeSubBox(doc, boxId)
    const after = snapshotSheet(doc)
    const entry = after.patches[patchKey(artist, channel)]
    expect(after.subBoxes).toHaveLength(0)
    expect(entry.subBoxId).toBeNull()
    expect(entry.subBoxText).toBe('Box 1 (MSC)')
    expect(patchSubBoxDisplay(entry, after.subBoxes)).toBe('Box 1 (MSC)')
  })
})

describe('artist files', () => {
  it('adds and removes file metadata', () => {
    const doc = newSheet()
    const artist = snapshotSheet(doc).artists[0].id
    addArtistFile(doc, artist, { id: 'f1', name: 'rider.pdf', type: 'application/pdf', size: 1234 })
    addArtistFile(doc, artist, { id: 'f2', name: 'stage.png', type: 'image/png', size: 999 })

    let files = snapshotSheet(doc).artists[0].files
    expect(files.map((f) => f.name)).toEqual(['rider.pdf', 'stage.png'])

    removeArtistFile(doc, artist, 'f1')
    files = snapshotSheet(doc).artists[0].files
    expect(files.map((f) => f.id)).toEqual(['f2'])
  })

  it('merges concurrent file additions from two devices', () => {
    const a = newSheet()
    const b = new Y.Doc()
    sync(a, b)
    const artist = snapshotSheet(a).artists[0].id

    addArtistFile(a, artist, { id: 'fa', name: 'from-a.pdf', type: 'application/pdf', size: 1 })
    addArtistFile(b, artist, { id: 'fb', name: 'from-b.png', type: 'image/png', size: 2 })
    sync(a, b)

    for (const doc of [a, b]) {
      const ids = snapshotSheet(doc)
        .artists[0].files.map((f) => f.id)
        .sort()
      expect(ids).toEqual(['fa', 'fb'])
    }
  })
})

describe('copyPatchesFromArtist', () => {
  it('copies all channel entries onto the target artist', () => {
    const doc = newSheet()
    const snap = snapshotSheet(doc)
    const source = snap.artists[0].id
    const channelA = snap.channels[0].id
    const channelB = snap.channels[1].id
    setPatchField(doc, source, channelA, 'input', 'Vocals')
    setPatchField(doc, source, channelB, 'micDi', 'SM58')

    const target = addArtist(doc)
    copyPatchesFromArtist(doc, source, target)
    const after = snapshotSheet(doc)
    expect(after.patches[patchKey(target, channelA)].input).toBe('Vocals')
    expect(after.patches[patchKey(target, channelB)].micDi).toBe('SM58')
  })
})

describe('concurrent editing (the scenarios v1 loses data on)', () => {
  it('merges concurrent edits to different cells from two offline devices', () => {
    const a = newSheet()
    const b = new Y.Doc()
    sync(a, b)

    const snap = snapshotSheet(a)
    const artist = snap.artists[0].id
    const [ch1, ch2] = [snap.channels[0].id, snap.channels[1].id]

    // Both devices edit while disconnected from each other.
    setPatchField(a, artist, ch1, 'input', 'Vocals from A')
    setPatchField(b, artist, ch2, 'input', 'Guitar from B')
    setMetaField(b, 'stage', 'Main Stage')

    sync(a, b)

    for (const doc of [a, b]) {
      const merged = snapshotSheet(doc)
      expect(merged.patches[patchKey(artist, ch1)].input).toBe('Vocals from A')
      expect(merged.patches[patchKey(artist, ch2)].input).toBe('Guitar from B')
      expect(merged.meta.stage).toBe('Main Stage')
    }
  })

  it('merges a concurrent channel insert and cell edit without losing either', () => {
    const a = newSheet()
    const b = new Y.Doc()
    sync(a, b)

    const snap = snapshotSheet(a)
    const artist = snap.artists[0].id
    const ch5 = snap.channels[4].id

    addChannel(a, snap.channels[1].id) // A inserts a channel near the top
    setPatchField(b, artist, ch5, 'description', 'Kick Drum') // B edits channel 5

    sync(a, b)

    for (const doc of [a, b]) {
      const merged = snapshotSheet(doc)
      expect(merged.channels).toHaveLength(11)
      // B's edit still belongs to the same channel row, wherever it now sits.
      expect(merged.patches[patchKey(artist, ch5)].description).toBe('Kick Drum')
      const rowIndex = merged.channels.findIndex((c) => c.id === ch5)
      expect(rowIndex).toBeGreaterThanOrEqual(0)
    }
  })

  it('converges when both devices edit the same cell', () => {
    const a = newSheet()
    const b = new Y.Doc()
    sync(a, b)

    const snap = snapshotSheet(a)
    const artist = snap.artists[0].id
    const ch = snap.channels[0].id
    setPatchField(a, artist, ch, 'input', 'From A')
    setPatchField(b, artist, ch, 'input', 'From B')

    sync(a, b)

    const valueA = snapshotSheet(a).patches[patchKey(artist, ch)].input
    const valueB = snapshotSheet(b).patches[patchKey(artist, ch)].input
    expect(valueA).toBe(valueB)
    expect(['From A', 'From B']).toContain(valueA)
  })
})
