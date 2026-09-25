import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { openEvent, storageName, storageNameFor } from '../../lib/eventScope.ts'
import {
  deleteLocalDatabase,
  holdsAllOf,
  MOVED_ORIGIN,
  readLocalCopy,
  whenPersisted,
} from '../../lib/docs/persistence.ts'
import { syncManager } from '../../lib/docs/sync.ts'
import { useDocSnapshot } from '../../lib/docs/hooks.ts'
import {
  createTimetableUndoManager,
  getTimetableRoots,
  sameRunningOrder,
  snapshotTimetable,
  type TimetableSnapshot,
} from './model.ts'

/**
 * The one timetable document, opened once for the life of the tab.
 *
 * Not built on createDocStore, which exists for modules that own *many*
 * documents — a sheet per stage, a plot per rig — and carries an index doc
 * and a selector to go with them. There is one running order on a box, so
 * there is nothing to index and nothing to choose between; all that
 * machinery would be answering a question nobody asks.
 *
 * Naming is load-bearing and reaches storage on real devices:
 *   IndexedDB db   `crewbox-timetable-event`
 *   relay room     `timetable/event`   (the server's namespace check)
 *
 * The database is the first event's; any other event a device holds has its
 * own (see lib/eventScope.ts). The room is the box's.
 */

const DOC_NAME = 'event'
const DB_NAME = 'crewbox-timetable-event'
export const TIMETABLE_ROOM = `timetable/${DOC_NAME}`

/** Where an event's copy of the running order is on this device. */
export const timetableDatabase = (event: string | null): string => storageNameFor(event, DB_NAME)

let handle: { doc: Y.Doc; undoManager: Y.UndoManager; whenLoaded: Promise<void> } | null = null

/** The timetable doc, created and connected on first use. */
export function timetable(): { doc: Y.Doc; undoManager: Y.UndoManager; whenLoaded: Promise<void> } {
  if (handle) return handle
  const doc = new Y.Doc()
  const undoManager = createTimetableUndoManager(doc)

  // No IndexedDB in the screenshot harness and some embedded webviews. The
  // timetable still works there, it just starts from whatever syncs.
  const hasIndexedDb = typeof indexedDB !== 'undefined'
  // A browser that *has* IndexedDB and refuses to open it is not the same as
  // one without it, and a timetable that waited on the wrong promise never
  // drew — the running order sat on "Loading…" for the whole shift. See
  // lib/docs/persistence.ts.
  const whenLoaded = whenPersisted(
    hasIndexedDb ? new IndexeddbPersistence(storageName(DB_NAME), doc) : null
  )

  // Synced, but not present. Every device on the box opens this document —
  // the sidebar countdown needs it whether or not anyone has looked at the
  // running order — and announcing all of them as *people* in the room would
  // put every phone on site into one awareness channel to say nothing.
  // Nothing displays presence here; the sheets and plots that do have their
  // own rooms.
  syncManager.attach(TIMETABLE_ROOM, doc, { present: false })
  handle = { doc, undoManager, whenLoaded }
  return handle
}

/**
 * The timetable as plain data, re-rendering on every edit from anywhere.
 *
 * Every consumer goes through this, so a set time corrected once moves
 * every countdown, every sheet and every module at the same moment.
 */
export function useTimetable(): { snapshot: TimetableSnapshot; loaded: boolean } {
  const { doc, whenLoaded } = timetable()
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    whenLoaded.then(() => live && setLoaded(true)).catch(() => {})
    return () => {
      live = false
    }
  }, [whenLoaded])

  const snapshot = useDocSnapshot(doc, snapshotTimetable)
  return { snapshot: snapshot ?? { acts: [] }, loaded }
}

/** How many acts another event's running order on this device has. */
export async function runningOrderActsOf(event: string): Promise<number> {
  const theirs = await readLocalCopy(timetableDatabase(event))
  return theirs ? getTimetableRoots(theirs).acts.length : 0
}

/**
 * What became of another event's running order, brought to the open one:
 * merged in; nothing to bring; left where it was because this box has one of
 * its own; or left because this device could not tell yet.
 */
export type RunningOrderMove = 'moved' | 'none' | 'kept' | 'unchecked'

/**
 * Bring another event's running order to the open event, and delete that
 * event's copy once this one is known to hold it.
 */
export async function moveRunningOrderFrom(event: string): Promise<RunningOrderMove> {
  const from = timetableDatabase(event)
  const here = timetableDatabase(openEvent())
  if (from === here) throw new Error('That is the open event.')
  const theirs = await readLocalCopy(from)
  if (!theirs || getTimetableRoots(theirs).acts.length === 0) return 'none'
  const { doc, whenLoaded } = timetable()
  await whenLoaded
  // Whether this box has a running order of its own is the box's to say, and
  // a device that has not heard from it yet cannot know.
  if (!(await syncManager.whenSynced(TIMETABLE_ROOM))) return 'unchecked'
  if (!sameRunningOrder(snapshotTimetable(doc).acts, snapshotTimetable(theirs).acts)) {
    return 'kept'
  }
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(theirs), MOVED_ORIGIN)
  const landed = await readLocalCopy(here)
  if (!landed || !holdsAllOf(landed, theirs)) return 'unchecked'
  await deleteLocalDatabase(from)
  return 'moved'
}
