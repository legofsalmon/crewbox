import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { newId } from '@crewbox/shared'
import { deletedIds, removeIndexEntry, upsertIndexEntry } from './indexDoc.ts'
import { whenPersisted } from './persistence.ts'
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
  /**
   * Give this hold back.
   *
   * One hold per `open`. The document is only torn down — socket, awareness
   * entry, IndexedDB connection — when the last one is released, so two panes
   * showing the same sheet share it and neither closing takes it from the
   * other.
   *
   * Every caller must release. Nothing did: an open document was kept for the
   * life of the tab, so a crew chief who looked at ten sheets during a load-in
   * held ten WebSocket rooms, ten IndexedDB connections and an awareness entry
   * in every one of them — a device that never left any room it had visited.
   */
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
  /**
   * Forget locally-held docs the index says have been deleted elsewhere.
   *
   * Returns the ids it dropped, so a caller can re-render. Deleting the
   * database is fire-and-forget — the listing is already correct without it.
   */
  reconcileDeletions: () => string[]
  /** Ids the index records as deleted, so a listing can skip them. */
  deleted: () => Set<string>
}

/**
 * How long a document stays open after its last holder lets go.
 *
 * Not zero. Navigating between two sheets unmounts one pane and mounts the
 * next, and React re-runs an effect on a dependency change by cleaning up
 * first — so a tab away and back, or a route change and an undo of it, would
 * otherwise tear down a WebSocket and an IndexedDB connection and build them
 * again a few milliseconds later, on a phone, over festival Wi-Fi.
 */
const CLOSE_GRACE_MS = 10_000

/**
 * Has this document anything in it at all?
 *
 * A Y.Doc that has never been written to has no client entries. Any content
 * from anywhere — this device, IndexedDB, the relay — puts one there, which
 * makes this the honest test for "does this document exist", as opposed to
 * "have we minted an empty one because somebody followed a link".
 */
export const docHasContent = (doc: Y.Doc): boolean => doc.store.clients.size > 0

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
    // A browser with no IndexedDB still gets the relay.
    //
    // It used to return here, with no persistence *and* no sync — so a
    // private window, or a browser with site data blocked, gave a crew member
    // a patch sheet that was theirs alone: their edits reached nobody and
    // nobody else's reached them, silently, with the sheet looking exactly
    // as it should. Persistence is an accelerator; the relay is where the
    // document actually lives, and that is true in both directions.
    const persistence = hasIndexedDb ? new IndexeddbPersistence(dbPrefix + docName, doc) : null
    // `typeof indexedDB !== 'undefined'` covers a browser with no IndexedDB
    // at all; it does not cover one that has it and refuses to open it. See
    // `whenPersisted`, which is where that is answered.
    const whenLoaded = whenPersisted(persistence)
    syncManager.attach(room(docName), doc, { present })
    return {
      doc,
      whenLoaded,
      destroy: () => {
        syncManager.detach(room(docName))
        persistence?.destroy()
        doc.destroy()
      },
    }
  }

  /**
   * Drop every trace of a document from *this* device.
   *
   * Used both when somebody deletes one here and when the index says
   * somebody deleted it elsewhere — a phone that had the sheet open at some
   * point is otherwise carrying a copy of paperwork the crew has thrown
   * away, and listing it.
   */
  const forget = async (id: string): Promise<void> => {
    writeRegistry(readRegistry().filter((known) => known !== id))
    if (!hasIndexedDb) return
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(dbPrefix + config.docName(id))
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    })
  }

  let indexHandle: DocHandle | null = null
  const openIndex = (): DocHandle => {
    if (!indexHandle) indexHandle = openRaw(INDEX_DOC_NAME)
    return indexHandle
  }

  /** One open document, and everybody currently holding it. */
  interface Held {
    handle: DocHandle
    /** How many `open` calls have not been released. */
    holds: number
    /** How many of those asked to be visible in the room. */
    presentHolds: number
    /** Teardown pending after the last release, if any. */
    closing: ReturnType<typeof setTimeout> | null
    close: () => void
  }

  const held = new Map<string, Held>()

  /**
   * `present: false` syncs the document without announcing this device in it.
   * For a reader that opens documents nobody asked to see — the running order
   * reads every patch sheet to work out what is on — so it does not show up
   * as company in a sheet somebody else has open. Opening the same document
   * normally afterwards promotes it, which is what happens the moment
   * someone actually looks at it.
   *
   * **Every call must be matched by `destroy` on the handle it returns.** The
   * document lives until the last holder lets go, and then a little longer —
   * see `CLOSE_GRACE_MS`.
   */
  const open = (id: string, { present = true }: { present?: boolean } = {}): DocHandle => {
    const docRoom = room(config.docName(id))
    const existing = held.get(id)
    if (existing) {
      // Reopened inside the grace window, or by a second pane: cancel any
      // pending teardown and take another hold.
      if (existing.closing) {
        clearTimeout(existing.closing)
        existing.closing = null
      }
      existing.holds++
      if (present) {
        existing.presentHolds++
        syncManager.attach(docRoom, existing.handle.doc, { present })
      }
      return releasable(id, existing, present)
    }

    const inner = openRaw(config.docName(id), present)
    const { doc } = inner
    const undoManager = config.undoManager?.(doc)

    /**
     * Remember this document locally — but only once it has content.
     *
     * The registry is what lets the selector list a document before (or
     * without) any sync, and it used to be written the moment a doc was
     * opened. So following a link to a sheet that has been deleted, or one
     * from a box this device is not on, minted an empty document and listed
     * it as "Untitled Sheet (local)" for ever, on a device whose owner had
     * only clicked a link.
     */
    let remembered = false
    const remember = () => {
      if (remembered || !docHasContent(doc)) return
      remembered = true
      const ids = readRegistry()
      if (!ids.includes(id)) writeRegistry([...ids, id])
    }
    void inner.whenLoaded.then(remember)

    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      // Content from anywhere — this device, the relay, IndexedDB — is what
      // makes the document real enough to list.
      remember()
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

    const entry: Held = {
      handle: { doc, whenLoaded: inner.whenLoaded, undoManager, destroy: () => {} },
      holds: 1,
      presentHolds: present ? 1 : 0,
      closing: null,
      close: () => {
        doc.off('update', onUpdate)
        undoManager?.destroy()
        held.delete(id)
        inner.destroy()
      },
    }
    held.set(id, entry)
    return releasable(id, entry, present)
  }

  /**
   * A handle over an already-counted hold, whose `destroy` releases just that
   * one. Idempotent, because React cleanups and explicit closes both happen
   * and a double release would evict a document another pane is using.
   */
  const releasable = (id: string, entry: Held, present: boolean): DocHandle => {
    let released = false
    return {
      ...entry.handle,
      destroy: () => {
        if (released) return
        released = true
        if (present && --entry.presentHolds === 0) {
          // Still syncing for whoever else holds it, but nobody is looking:
          // leave the room rather than staying in it as a phantom device.
          syncManager.unannounce(room(config.docName(id)))
        }
        if (--entry.holds > 0) return
        entry.closing = setTimeout(() => {
          entry.closing = null
          if (entry.holds === 0) entry.close()
        }, CLOSE_GRACE_MS)
      },
    }
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
      // And give the hold straight back. Callers use the id and navigate;
      // none of them holds this handle, so keeping the reference here would
      // leak one open document per document ever created in a session. The
      // grace window covers the gap until the pane opens it properly.
      handle.destroy()
      return { id, handle }
    },

    remove: async (id) => {
      // Deliberately not a release: a deletion ends the document for
      // everybody holding it, and leaving the socket open for the grace
      // window would let a straggling write resurrect it.
      held.get(id)?.close()
      removeIndexEntry(openIndex().doc, id, config.localOrigin)
      await forget(id)
    },

    reconcileDeletions: () => {
      const gone = deletedIds(openIndex().doc)
      const dropped = readRegistry().filter((id) => gone.has(id))
      for (const id of dropped) void forget(id)
      return dropped
    },

    deleted: () => deletedIds(openIndex().doc),

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
