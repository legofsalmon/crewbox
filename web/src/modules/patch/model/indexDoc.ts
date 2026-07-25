import type * as Y from 'yjs'
import {
  removeIndexEntry as removeEntry,
  snapshotIndex as snapshotDocIndex,
  upsertIndexEntry as upsertEntry,
} from '../../_shared/docs/indexDoc'
import type { SheetIndexEntry } from './types'
import { LOCAL_ORIGIN } from './sheetDoc'

/**
 * Patch's view of the shared index doc: sheets carry a stage and a date
 * alongside the universal title/lastModified, and the selector wants them as
 * plain fields rather than digging through `meta`.
 */

const DEFAULT_TITLE = 'Untitled Sheet'

export const upsertIndexEntry = (
  doc: Y.Doc,
  sheetId: string,
  fields: Partial<Omit<SheetIndexEntry, 'sheetId'>>
) => upsertEntry(doc, sheetId, fields as Record<string, string>, LOCAL_ORIGIN)

export const removeIndexEntry = (doc: Y.Doc, sheetId: string) =>
  removeEntry(doc, sheetId, LOCAL_ORIGIN)

/** All entries, most recently modified first. */
export const snapshotIndex = (doc: Y.Doc): SheetIndexEntry[] =>
  snapshotDocIndex(doc, DEFAULT_TITLE).map((entry) => ({
    sheetId: entry.id,
    title: entry.title,
    stage: entry.meta.stage ?? '',
    date: entry.meta.date ?? '',
    lastModified: entry.lastModified,
  }))
