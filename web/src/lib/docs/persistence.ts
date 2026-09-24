import * as Y from 'yjs'

/**
 * When a document's local copy is ready — or has proved it never will be.
 *
 * `IndexeddbPersistence.whenSynced` resolves when the 'synced' event fires
 * and **never rejects**: a browser that has IndexedDB and refuses to open it
 * — a corrupted profile, a private window, a quota that has run out — leaves
 * that promise pending for the life of the tab. Both call sites had a
 * rejection handler on it and a comment saying it "resolves either way",
 * and neither was true: the handler could not run, so a pane awaiting it sat
 * on "Loading sheet…" for ever. The failed open was also an unhandled
 * rejection on the library's own `_db`, once per document.
 *
 * The open is the thing to watch. It rejects when there is no local copy to
 * wait for, in which case there is nothing to wait for; it resolves when
 * there is, and then 'synced' is the honest signal. The timeout is for the
 * third case nobody can enumerate — an open that succeeds and a read that
 * wedges — because a document that is on the relay is still perfectly
 * usable, and persistence is an accelerator.
 */

/** The parts of `IndexeddbPersistence` that answer the question. */
export interface LocalCopy {
  whenSynced: Promise<unknown>
  /**
   * The library's own open promise. Private by name and public in its type
   * declaration, and the only place a failed open is observable.
   */
  _db: Promise<unknown>
}

/** Long enough that a real read is never cut short on a slow phone. */
export const LOAD_TIMEOUT_MS = 10_000

export function whenPersisted(local: LocalCopy | null, timeoutMs = LOAD_TIMEOUT_MS): Promise<void> {
  if (!local) return Promise.resolve()
  const ready = local._db.then(
    () => local.whenSynced.then(() => undefined),
    () => undefined
  )
  return Promise.race([ready, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
}

/** Stamped on a merge from another event's copy: nobody's edit, and not undoable. */
export const MOVED_ORIGIN = Symbol('moved from another event')

/**
 * A document as one of this device's databases holds it, read and left
 * exactly as it was.
 *
 * For moving another event's copy, or checking that a copy landed. Not
 * through y-indexeddb, whose open writes to the database, and makes one where
 * there was none: this reads the stored updates and nothing else. Null when
 * there is no such database, or it cannot be read.
 */
export function readLocalCopy(name: string): Promise<Y.Doc | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(name)
    } catch {
      return resolve(null)
    }
    // Opening one that is not there would make it. Aborting that leaves none.
    req.onupgradeneeded = () => req.transaction?.abort()
    req.onerror = () => resolve(null)
    req.onsuccess = () => {
      const db = req.result
      try {
        const all = db.transaction('updates', 'readonly').objectStore('updates').getAll()
        all.onsuccess = () => {
          db.close()
          const doc = new Y.Doc()
          Y.transact(doc, () => {
            for (const update of all.result as Uint8Array[]) Y.applyUpdate(doc, update)
          })
          resolve(doc)
        }
        all.onerror = () => {
          db.close()
          resolve(null)
        }
      } catch {
        // Not a document's database: no `updates` store.
        db.close()
        resolve(null)
      }
    }
  })
}

/** Whether a document holds everything another does: its content and its deletions. */
export const holdsAllOf = (doc: Y.Doc, other: Y.Doc): boolean =>
  Y.snapshotContainsUpdate(Y.snapshot(doc), Y.encodeStateAsUpdate(other))

/** Delete one of this device's databases, whether or not anything still has it open. */
export function deleteLocalDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve()
    const req = indexedDB.deleteDatabase(name)
    // Blocked is somebody else still holding it open, another tab perhaps:
    // the delete goes through when they let go, and nothing here waits.
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
}
