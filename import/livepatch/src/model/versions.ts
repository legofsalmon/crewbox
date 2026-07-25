import * as Y from 'yjs'
import { applySnapshot, LOCAL_ORIGIN, snapshotSheet } from './sheetDoc'
import type { SheetSnapshot } from './types'

/**
 * Named point-in-time copies of a sheet ("after soundcheck", "pre-doors"),
 * stored inside the sheet doc under a root the undo manager does NOT track:
 * saving or deleting a version never touches the undo stack, while versions
 * still persist and sync like any other doc content. Entries are immutable
 * plain objects, so concurrent saves from two devices merge as two entries.
 */
export interface SheetVersion {
  id: string
  name: string
  createdAt: string
  /** JSON-serialized SheetSnapshot captured at save time. */
  data: string
}

export const getVersionsRoot = (doc: Y.Doc): Y.Array<SheetVersion> =>
  doc.getArray<SheetVersion>('versions')

/** Saved versions, newest first. */
export const listVersions = (doc: Y.Doc): SheetVersion[] =>
  getVersionsRoot(doc)
    .toArray()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

export const saveVersion = (doc: Y.Doc, name: string, now?: string): SheetVersion => {
  const version: SheetVersion = {
    id: crypto.randomUUID(),
    name: name.trim() || 'Untitled version',
    createdAt: now ?? new Date().toISOString(),
    data: JSON.stringify(snapshotSheet(doc)),
  }
  doc.transact(() => getVersionsRoot(doc).push([version]), LOCAL_ORIGIN)
  return version
}

export const deleteVersion = (doc: Y.Doc, versionId: string): void => {
  const versions = getVersionsRoot(doc)
  doc.transact(() => {
    for (let i = versions.length - 1; i >= 0; i--) {
      if (versions.get(i).id === versionId) versions.delete(i)
    }
  }, LOCAL_ORIGIN)
}

export const versionSnapshot = (version: SheetVersion): SheetSnapshot =>
  JSON.parse(version.data) as SheetSnapshot

/**
 * Replace the sheet's current content with a saved version. The write goes
 * through applySnapshot's single LOCAL_ORIGIN transaction, so one Ctrl+Z
 * brings back the pre-restore state. The version list itself is unchanged.
 */
export const restoreVersion = (doc: Y.Doc, versionId: string): boolean => {
  const version = getVersionsRoot(doc)
    .toArray()
    .find((v) => v.id === versionId)
  if (!version) return false
  applySnapshot(doc, versionSnapshot(version))
  return true
}
