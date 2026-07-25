import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { newId } from '@crewbox/shared'
import {
  buildImportedSheet,
  createSheetUndoManager,
  getSheetRoots,
  initSheet,
  LOCAL_ORIGIN,
  type ImportedSheetData,
} from '../model/sheetDoc'
import { removeIndexEntry, upsertIndexEntry } from '../model/indexDoc'
import { syncManager } from './sync.ts'

/**
 * Owns the lifecycle of Y.Docs and their IndexedDB persistence. One doc per
 * sheet plus a singleton index doc. The short doc name ('sheet-<id>',
 * 'index') keys sync and presence; the IndexedDB database name carries a
 * crewbox-patch- prefix on top of it.
 */

const DB_PREFIX = 'crewbox-patch-'
/** localStorage registry of sheet ids with data on this device. */
const LOCAL_SHEETS_KEY = 'crewbox:patch-sheets'

export const INDEX_DOC_NAME = 'index'

export const sheetDocName = (sheetId: string) => `sheet-${sheetId}`

export interface DocHandle {
  doc: Y.Doc
  /** Resolves once IndexedDB has loaded the doc's persisted state. */
  whenLoaded: Promise<void>
  /** Undo/redo over this client's local edits — sheet docs only, not the index. */
  undoManager?: Y.UndoManager
  destroy: () => void
}

const hasIndexedDb = typeof indexedDB !== 'undefined'

function readLocalSheetIds(): string[] {
  try {
    const raw = localStorage.getItem(LOCAL_SHEETS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeLocalSheetIds(ids: string[]): void {
  try {
    localStorage.setItem(LOCAL_SHEETS_KEY, JSON.stringify(ids))
  } catch {
    // Registry is best-effort; the synced index is the primary listing.
  }
}

function rememberLocalSheet(sheetId: string): void {
  const ids = readLocalSheetIds()
  if (!ids.includes(sheetId)) writeLocalSheetIds([...ids, sheetId])
}

function forgetLocalSheet(sheetId: string): void {
  writeLocalSheetIds(readLocalSheetIds().filter((id) => id !== sheetId))
}

const openDoc = (name: string): DocHandle => {
  const doc = new Y.Doc()
  if (!hasIndexedDb) {
    return { doc, whenLoaded: Promise.resolve(), destroy: () => doc.destroy() }
  }
  const persistence = new IndexeddbPersistence(DB_PREFIX + name, doc)
  const whenLoaded = persistence.whenSynced.then(() => undefined)
  syncManager.attach(name, doc)
  return {
    doc,
    whenLoaded,
    destroy: () => {
      syncManager.detach(name)
      persistence.destroy()
      doc.destroy()
    },
  }
}

let indexHandle: DocHandle | null = null

/** The singleton index doc; opened lazily, kept open for the app's lifetime. */
export const openIndex = (): DocHandle => {
  if (!indexHandle) indexHandle = openDoc(INDEX_DOC_NAME)
  return indexHandle
}

const sheetHandles = new Map<string, DocHandle>()

/**
 * Open (or reuse) a sheet doc. Local edits automatically refresh the sheet's
 * index entry — title, stage, date, and lastModified — so the selector stays
 * current without every mutation knowing about the index.
 */
export const openSheet = (sheetId: string): DocHandle => {
  const existing = sheetHandles.get(sheetId)
  if (existing) return existing

  const inner = openDoc(sheetDocName(sheetId))
  const { doc } = inner
  const undoManager = createSheetUndoManager(doc)
  rememberLocalSheet(sheetId)

  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    // Local edits and their undo/redo both count as "modified" for the index.
    if (origin !== LOCAL_ORIGIN && origin !== undoManager) return
    const { meta } = getSheetRoots(doc)
    upsertIndexEntry(openIndex().doc, sheetId, {
      title: (meta.get('title') as string) ?? 'Untitled Sheet',
      stage: (meta.get('stage') as string) ?? '',
      date: (meta.get('date') as string) ?? '',
      lastModified: new Date().toISOString(),
    })
  }
  doc.on('update', onUpdate)

  const handle: DocHandle = {
    doc,
    whenLoaded: inner.whenLoaded,
    undoManager,
    destroy: () => {
      doc.off('update', onUpdate)
      undoManager.destroy()
      sheetHandles.delete(sheetId)
      inner.destroy()
    },
  }
  sheetHandles.set(sheetId, handle)
  return handle
}

/** Create a new sheet: fresh id, default structure, index entry. */
export const createSheet = (title: string): { sheetId: string; handle: DocHandle } => {
  const sheetId = newId()
  const handle = openSheet(sheetId)
  initSheet(handle.doc, { title })
  // The default structure is the sheet's baseline, not an undoable edit.
  handle.undoManager?.clear()
  return { sheetId, handle }
}

/** Create a new sheet from imported CSV data (see model/importCsv.ts). */
export const createSheetFromImport = (
  title: string,
  data: ImportedSheetData
): { sheetId: string; handle: DocHandle } => {
  const sheetId = newId()
  const handle = openSheet(sheetId)
  buildImportedSheet(handle.doc, data, { title })
  // Imported content is the sheet's baseline, not an undoable edit.
  handle.undoManager?.clear()
  return { sheetId, handle }
}

/** Delete a sheet's local data and index entry. */
export const deleteSheet = async (sheetId: string): Promise<void> => {
  sheetHandles.get(sheetId)?.destroy()
  removeIndexEntry(openIndex().doc, sheetId)
  forgetLocalSheet(sheetId)
  if (hasIndexedDb) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_PREFIX + sheetDocName(sheetId))
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    })
  }
}

/**
 * Sheet ids with data on this device — lets the selector list local sheets
 * even if they're missing from the (possibly never-synced) index. A
 * localStorage registry maintained on open/delete, not
 * indexedDB.databases(): that API enumerates the whole origin (every
 * module's databases) and doesn't exist in Firefox.
 */
export const listLocalSheetIds = async (): Promise<string[]> => {
  return readLocalSheetIds()
}
