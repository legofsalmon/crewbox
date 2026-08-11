import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { newId } from '@crewbox/shared'
import { removeIndexEntry, upsertIndexEntry } from './indexDoc.ts'
import { syncManager } from './sync.ts'

/**
 * Doc lifecycle for a module: one Y.Doc per document plus a singleton index
 * doc, each backed by IndexedDB and synced through the shared relay.
 *
 * Everything module-specific arrives through config — how a doc id becomes a
 * doc name, what gets projected into the index on edit, which roots undo
 * covers. What's left is identical for every module, which is the point:
 * module #2 declares a config instead of copying two hundred lines of
 * lifecycle it would then have to keep in step.
 *
 * Naming is load-bearing and reaches storage on real devices:
 *   IndexedDB db   `crewbox-<moduleId>-<docName>`
 *   relay room     `<moduleId>/<docName>`   (the server's namespace check)
 *   registry key   `crewbox:<moduleId>-docs`
 */

export interface DocHandle {
  doc: Y.Doc
  /** Resolves once IndexedDB has loaded the doc's persisted state. */
  whenLoaded: Promise<void>
  /** Undo/redo over this client's local edits — content docs only, not the index. */
  undoManager?: Y.UndoManager
  destroy: () => void
}

export interface DocStoreConfig {
  /** Must match a module id the server accepts in room names. */
  moduleId: string
  /** Doc id → short doc name, e.g. `sheet-<id>`. Keys storage and sync. */
  docName: (id: string) => string
  /** Transaction origin this module stamps on local edits. */
  localOrigin: unknown
  /** Title used for index entries that arrive without one. */
  defaultTitle: string
  /**
   * Fields to write into the index whenever this device edits a doc. Called
   * with the freshly-updated doc; return whatever the selector shows.
   * `lastModified` is added by the store.
   */
  indexFields: (doc: Y.Doc) => Record<string, string>
  /** Undo/redo scope. Omit for a module without undo. */
  undoManager?: (doc: Y.Doc) => Y.UndoManager
  /**
   * Override the localStorage registry key. Only for modules that shipped
   * before this store existed and would orphan devices in the field.
   */
  registryKey?: string
}

export interface DocStore {
  /** Short name of the index doc within this module's namespace. */
  readonly indexDocName: string
  /** Title for index entries that arrive without one. */
  readonly defaultTitle: string
  docName: (id: string) => string
  /** Full relay room name — the identity the sync manager is keyed by. */
  room: (id: string) => string
  openIndex: () => DocHandle
  /**
   * `present: false` syncs the doc without announcing this device in it —
   * for background readers. See the implementation's note.
   */
  open: (id: string, opts?: { present?: boolean }) => DocHandle
  /** Mint an id, open it, run `init`, and treat the result as the baseline. */
  create: (init: (doc: Y.Doc) => void) => { id: string; handle: DocHandle }
  remove: (id: string) => Promise<void>
  /** Doc ids with data on this device (see listLocalIds' note). */
  listLocalIds: () => string[]
}

const INDEX_DOC_NAME = 'index'

const hasIndexedDb = typeof indexedDB !== 'undefined'

export function createDocStore(config: DocStoreConfig): DocStore {
  const dbPrefix = `crewbox-${config.moduleId}-`
  const registryKey = config.registryKey ?? `crewbox:${config.moduleId}-docs`
  const room = (docName: string) => `${config.moduleId}/${docName}`

  function readRegistry(): string[] {
    try {
      const raw = localStorage.getItem(registryKey)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : []
    } catch {
      return []
    }
  }

  function writeRegistry(ids: string[]): void {
    try {
      localStorage.setItem(registryKey, JSON.stringify(ids))
    } catch {
      // Registry is best-effort; the synced index is the primary listing.
    }
  }

  const openRaw = (docName: string, present = true): DocHandle => {
    const doc = new Y.Doc()
    if (!hasIndexedDb) {
      return { doc, whenLoaded: Promise.resolve(), destroy: () => doc.destroy() }
    }
    const persistence = new IndexeddbPersistence(dbPrefix + docName, doc)
    const whenLoaded = persistence.whenSynced.then(() => undefined)
    syncManager.attach(room(docName), doc, { present })
    return {
      doc,
      whenLoaded,
      destroy: () => {
        syncManager.detach(room(docName))
        persistence.destroy()
        doc.destroy()
      },
    }
  }

  let indexHandle: DocHandle | null = null
  const openIndex = (): DocHandle => {
    if (!indexHandle) indexHandle = openRaw(INDEX_DOC_NAME)
    return indexHandle
  }

  const handles = new Map<string, DocHandle>()

  /**
   * `present: false` syncs the document without announcing this device in it.
   * For a reader that opens documents nobody asked to see — the running order
   * reads every patch sheet to work out what is on — so it does not show up
   * as company in a sheet somebody else has open. Opening the same document
   * normally afterwards promotes it, which is what happens the moment
   * someone actually looks at it.
   */
  const open = (id: string, { present = true }: { present?: boolean } = {}): DocHandle => {
    const existing = handles.get(id)
    if (existing) {
      if (present) syncManager.attach(room(config.docName(id)), existing.doc, { present })
      return existing
    }

    const inner = openRaw(config.docName(id), present)
    const { doc } = inner
    const undoManager = config.undoManager?.(doc)

    const ids = readRegistry()
    if (!ids.includes(id)) writeRegistry([...ids, id])

    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      // Local edits and their undo/redo both count as "modified" for the index.
      if (origin !== config.localOrigin && (!undoManager || origin !== undoManager)) return
      upsertIndexEntry(
        openIndex().doc,
        id,
        { ...config.indexFields(doc), lastModified: new Date().toISOString() },
        config.localOrigin
      )
    }
    doc.on('update', onUpdate)

    const handle: DocHandle = {
      doc,
      whenLoaded: inner.whenLoaded,
      undoManager,
      destroy: () => {
        doc.off('update', onUpdate)
        undoManager?.destroy()
        handles.delete(id)
        inner.destroy()
      },
    }
    handles.set(id, handle)
    return handle
  }

  return {
    indexDocName: INDEX_DOC_NAME,
    defaultTitle: config.defaultTitle,
    docName: config.docName,
    room: (id: string) => room(config.docName(id)),
    openIndex,
    open,

    create: (init) => {
      const id = newId()
      const handle = open(id)
      init(handle.doc)
      // The initial structure is the doc's baseline, not an undoable edit.
      handle.undoManager?.clear()
      return { id, handle }
    },

    remove: async (id) => {
      handles.get(id)?.destroy()
      removeIndexEntry(openIndex().doc, id, config.localOrigin)
      writeRegistry(readRegistry().filter((known) => known !== id))
      if (hasIndexedDb) {
        await new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(dbPrefix + config.docName(id))
          req.onsuccess = req.onerror = req.onblocked = () => resolve()
        })
      }
    },

    /**
     * Doc ids with data on this device — lets a selector list docs even if
     * they're missing from the (possibly never-synced) index. A localStorage
     * registry maintained on open/delete, not indexedDB.databases(): that API
     * enumerates the whole origin (every module's databases) and doesn't
     * exist in Firefox.
     */
    listLocalIds: readRegistry,
  }
}
