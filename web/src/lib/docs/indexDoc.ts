import * as Y from 'yjs'

/**
 * Every doc-backed module needs the same thing: a small Y.Doc listing the
 * documents that exist, so a selector can show docs living on other devices
 * before their (potentially large) contents have synced.
 *
 * Two fields are universal — every module's selector shows a name and a
 * recency — and the rest is whatever that module wants to surface in a list
 * row (patch: stage and date). Extras ride in `meta` rather than widening
 * this type per module.
 */
export interface DocIndexEntry {
  id: string
  title: string
  /** ISO timestamp; empty string sorts last. */
  lastModified: string
  meta: Record<string, string>
}

const getEntries = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('sheets')

/**
 * Historical root name. The map key is 'sheets' because the patch module
 * shipped first and wrote that name into every synced index doc in the
 * field; renaming it would strand those entries. It holds any module's
 * documents.
 */

export const upsertIndexEntry = (
  doc: Y.Doc,
  id: string,
  fields: Record<string, string>,
  origin: unknown
) => {
  doc.transact(() => {
    const entries = getEntries(doc)
    let entry = entries.get(id)
    if (!entry) {
      entry = new Y.Map<unknown>()
      entries.set(id, entry)
    }
    for (const [k, v] of Object.entries(fields)) entry.set(k, v)
  }, origin)
}

/**
 * Documents that have been deleted, id → when.
 *
 * Deleting the index row is not enough on its own. Every device keeps a
 * local registry of the docs it has data for, and the selector merges that
 * registry in so a doc still lists before (or without) any sync. So a sheet
 * deleted on the desk vanished from the index on every phone and came
 * straight back on each of them as "Untitled Sheet (local)" — un-deletable,
 * because the thing they were listing was their own copy.
 *
 * A tombstone says "gone", which absence cannot. It is a small map of ids
 * and timestamps: the whole point is to be cheap enough to keep for ever,
 * because the day it is pruned is the day an offline phone reconnects and
 * resurrects the sheet again.
 */
const getTombstones = (doc: Y.Doc) => doc.getMap<string>('deleted')

/** Ids this index says have been deleted. */
export const deletedIds = (doc: Y.Doc): Set<string> => new Set(getTombstones(doc).keys())

export const removeIndexEntry = (doc: Y.Doc, id: string, origin: unknown, at = new Date()) => {
  doc.transact(() => {
    getEntries(doc).delete(id)
    getTombstones(doc).set(id, at.toISOString())
  }, origin)
}

/** All entries, most recently modified first. Deleted docs are never listed. */
export const snapshotIndex = (doc: Y.Doc, defaultTitle: string): DocIndexEntry[] => {
  const entries: DocIndexEntry[] = []
  const gone = deletedIds(doc)
  for (const [id, entry] of getEntries(doc).entries()) {
    // A row and a tombstone for the same id means two devices disagreed —
    // one deleting while the other edited. Deletion is the destructive
    // answer and the one somebody chose deliberately, so it wins.
    if (gone.has(id)) continue
    const json = entry.toJSON() as Record<string, unknown>
    const meta: Record<string, string> = {}
    for (const [k, v] of Object.entries(json)) {
      if (k === 'title' || k === 'lastModified') continue
      if (typeof v === 'string') meta[k] = v
    }
    entries.push({
      id,
      title: typeof json.title === 'string' ? json.title : defaultTitle,
      lastModified: typeof json.lastModified === 'string' ? json.lastModified : '',
      meta,
    })
  }
  entries.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1))
  return entries
}
