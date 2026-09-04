import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { removeIndexEntry, snapshotIndex, upsertIndexEntry } from './indexDoc'

describe('index doc', () => {
  it('upserts entries and lists them most recently modified first', () => {
    const doc = new Y.Doc()
    upsertIndexEntry(doc, 'a', {
      title: 'Older',
      stage: 'A',
      date: '2026-01-01',
      lastModified: '2026-01-01T10:00:00.000Z',
    })
    upsertIndexEntry(doc, 'b', {
      title: 'Newer',
      stage: 'B',
      date: '2026-02-01',
      lastModified: '2026-02-01T10:00:00.000Z',
    })

    let entries = snapshotIndex(doc)
    expect(entries.map((e) => e.title)).toEqual(['Newer', 'Older'])

    upsertIndexEntry(doc, 'a', { lastModified: '2026-03-01T10:00:00.000Z' })
    entries = snapshotIndex(doc)
    expect(entries.map((e) => e.title)).toEqual(['Older', 'Newer'])
    expect(entries[0]).toMatchObject({ sheetId: 'a', stage: 'A' })
  })

  it('removes entries', () => {
    const doc = new Y.Doc()
    upsertIndexEntry(doc, 'a', { title: 'One' })
    removeIndexEntry(doc, 'a')
    expect(snapshotIndex(doc)).toHaveLength(0)
  })

  it('keeps a deleted sheet deleted when another device edits it', () => {
    /**
     * The race two people at a festival actually have: one deletes a sheet
     * on the desk while another is still typing into it on a phone. The
     * phone's edit re-creates the index row, so absence alone would list the
     * sheet again on every device — a deletion that undid itself.
     *
     * Deletion wins. It is the destructive answer and the one somebody chose
     * deliberately, and the sheet's own document is still on the phone that
     * has it if anybody needs what was typed.
     */
    const desk = new Y.Doc()
    const phone = new Y.Doc()
    upsertIndexEntry(desk, 'sheet-1', { title: 'Second Stage' })
    Y.applyUpdate(phone, Y.encodeStateAsUpdate(desk))

    removeIndexEntry(desk, 'sheet-1')
    upsertIndexEntry(phone, 'sheet-1', { title: 'Second Stage', lastModified: 'later' })

    Y.applyUpdate(phone, Y.encodeStateAsUpdate(desk, Y.encodeStateVector(phone)))
    Y.applyUpdate(desk, Y.encodeStateAsUpdate(phone, Y.encodeStateVector(desk)))

    expect(snapshotIndex(desk)).toEqual([])
    expect(snapshotIndex(phone)).toEqual([])
  })

  it('merges concurrent index updates from two devices', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    upsertIndexEntry(a, 'sheet-1', { title: 'From A', lastModified: '2026-01-02T00:00:00.000Z' })
    upsertIndexEntry(b, 'sheet-2', { title: 'From B', lastModified: '2026-01-01T00:00:00.000Z' })

    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))

    for (const doc of [a, b]) {
      expect(snapshotIndex(doc).map((e) => e.title)).toEqual(['From A', 'From B'])
    }
  })
})
