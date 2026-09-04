import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { syncManager } from '../../lib/docs/sync.ts'
import { useDocSnapshot } from '../../lib/docs/hooks.ts'
import { createTimetableUndoManager, snapshotTimetable, type TimetableSnapshot } from './model.ts'

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
 */

const DOC_NAME = 'event'
const DB_NAME = 'crewbox-timetable-event'
export const TIMETABLE_ROOM = `timetable/${DOC_NAME}`

let handle: { doc: Y.Doc; undoManager: Y.UndoManager; whenLoaded: Promise<void> } | null = null

/** The timetable doc, created and connected on first use. */
export function timetable(): { doc: Y.Doc; undoManager: Y.UndoManager; whenLoaded: Promise<void> } {
  if (handle) return handle
  const doc = new Y.Doc()
  const undoManager = createTimetableUndoManager(doc)

  // No IndexedDB in the screenshot harness and some embedded webviews. The
  // timetable still works there, it just starts from whatever syncs.
  const hasIndexedDb = typeof indexedDB !== 'undefined'
  // Resolves either way: a browser that *has* IndexedDB and refuses to open
  // it rejects rather than being absent, and a timetable that waited on that
  // promise would never draw. See lib/docs/store.ts.
  const whenLoaded = hasIndexedDb
    ? new IndexeddbPersistence(DB_NAME, doc).whenSynced.then(
        () => undefined,
        () => undefined
      )
    : Promise.resolve()

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
