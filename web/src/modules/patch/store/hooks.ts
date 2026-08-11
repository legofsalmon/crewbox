import type * as Y from 'yjs'
import { useDocIndex, useStoreDoc } from '../../../lib/docs/hooks.ts'
import { snapshotSheet } from '../model/sheetDoc'
import type { SheetIndexEntry, SheetSnapshot } from '../model/types'
import { sheetStore } from './docManager.ts'

export { useDocSnapshot } from '../../../lib/docs/hooks.ts'

/** Open a sheet doc for the component's lifetime and render its live snapshot. */
export function useSheet(sheetId: string | null): {
  doc: Y.Doc | null
  snapshot: SheetSnapshot | null
  loaded: boolean
  undoManager: Y.UndoManager | null
} {
  return useStoreDoc(sheetStore, sheetId, snapshotSheet)
}

/** The sheet index (selector list), merged with sheets found only locally. */
export function useSheetIndex(): { entries: SheetIndexEntry[]; loaded: boolean } {
  const { entries, loaded } = useDocIndex(sheetStore)
  return {
    entries: entries.map((entry) => ({
      sheetId: entry.id,
      title: entry.title,
      stage: entry.meta.stage ?? '',
      date: entry.meta.date ?? '',
      lastModified: entry.lastModified,
    })),
    loaded,
  }
}
