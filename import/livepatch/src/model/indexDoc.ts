import * as Y from 'yjs'
import type { SheetIndexEntry } from './types'
import { LOCAL_ORIGIN } from './sheetDoc'

/**
 * The index doc is a single small Y.Doc listing every known sheet, so the
 * selector can show sheets that exist on other devices before their full
 * documents have synced.
 */

const getSheets = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('sheets')

export const upsertIndexEntry = (
  doc: Y.Doc,
  sheetId: string,
  fields: Partial<Omit<SheetIndexEntry, 'sheetId'>>
) => {
  doc.transact(() => {
    const sheets = getSheets(doc)
    let entry = sheets.get(sheetId)
    if (!entry) {
      entry = new Y.Map<unknown>()
      sheets.set(sheetId, entry)
    }
    for (const [k, v] of Object.entries(fields)) entry.set(k, v)
  }, LOCAL_ORIGIN)
}

export const removeIndexEntry = (doc: Y.Doc, sheetId: string) => {
  doc.transact(() => {
    getSheets(doc).delete(sheetId)
  }, LOCAL_ORIGIN)
}

/** All entries, most recently modified first. */
export const snapshotIndex = (doc: Y.Doc): SheetIndexEntry[] => {
  const entries: SheetIndexEntry[] = []
  for (const [sheetId, entry] of getSheets(doc).entries()) {
    const json = entry.toJSON() as Partial<SheetIndexEntry>
    entries.push({
      sheetId,
      title: json.title ?? 'Untitled Sheet',
      stage: json.stage ?? '',
      date: json.date ?? '',
      lastModified: json.lastModified ?? '',
    })
  }
  entries.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1))
  return entries
}
