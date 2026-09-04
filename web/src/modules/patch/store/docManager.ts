import type * as Y from 'yjs'
import { createDocStore, type DocHandle } from '../../../lib/docs/store.ts'
import { timetable } from '../../../shell/timetable/store.ts'
import {
  buildImportedSheet,
  createSheetUndoManager,
  getSheetRoots,
  initSheet,
  LOCAL_ORIGIN,
  type ImportedSheetData,
  type ImportedSheetReport,
} from '../model/sheetDoc'

/**
 * The patch module's doc store: one doc per sheet plus the shared index.
 * Everything below is patch-specific configuration — the lifecycle itself
 * (IndexedDB, sync, the local registry, deletion) lives in lib/docs.
 */

export type { DocHandle }

export const sheetDocName = (sheetId: string) => `sheet-${sheetId}`

export const DEFAULT_SHEET_TITLE = 'Untitled Sheet'

export const sheetStore = createDocStore({
  moduleId: 'patch',
  docName: sheetDocName,
  localOrigin: LOCAL_ORIGIN,
  defaultTitle: DEFAULT_SHEET_TITLE,
  undoManager: createSheetUndoManager,
  // Sheets shipped before the shared store existed, under this key. Renaming
  // it would orphan the registry on devices already carrying sheets.
  registryKey: 'crewbox:patch-sheets',
  indexFields: (doc) => {
    const { meta } = getSheetRoots(doc)
    return {
      title: (meta.get('title') as string) ?? DEFAULT_SHEET_TITLE,
      stage: (meta.get('stage') as string) ?? '',
      date: (meta.get('date') as string) ?? '',
    }
  },
})

export const INDEX_DOC_NAME = sheetStore.indexDocName

/** Full relay room for a sheet — what presence and peer counts are keyed by. */
export const sheetRoom = (sheetId: string) => sheetStore.room(sheetId)

export const openIndex = (): DocHandle => sheetStore.openIndex()

export const openSheet = (sheetId: string): DocHandle => sheetStore.open(sheetId)

/**
 * Create a new sheet: fresh id, default structure, index entry.
 *
 * Nothing is written to the running order. Acts live there and are the whole
 * event's, so a new patch sheet has no business adding one — see `initSheet`.
 */
export const createSheet = (title: string): { sheetId: string; handle: DocHandle } => {
  const { id, handle } = sheetStore.create((doc: Y.Doc) => initSheet(doc, { title }))
  return { sheetId: id, handle }
}

/**
 * Create a new sheet from imported CSV data (see model/importCsv.ts).
 *
 * The acts in the file land on the running order, so importing a festival's
 * master patch is also how the box learns the day's timetable — every other
 * department gets it at the same moment audio does.
 */
export const createSheetFromImport = (
  title: string,
  data: ImportedSheetData
): { sheetId: string; handle: DocHandle; report: ImportedSheetReport } => {
  // Caught in a closure rather than threaded through the shared store: the
  // store's job is a doc's lifecycle, and what one module's importer wants to
  // say about a file is not part of it.
  let report: ImportedSheetReport = { duplicateActs: [] }
  const { id, handle } = sheetStore.create((doc: Y.Doc) => {
    report = buildImportedSheet(doc, timetable().doc, data, { title })
  })
  return { sheetId: id, handle, report }
}

/** Delete a sheet's local data and index entry. */
export const deleteSheet = (sheetId: string): Promise<void> => sheetStore.remove(sheetId)
