import type * as Y from 'yjs'
import { useDocIndex, useStoreDoc } from '../../../lib/docs/hooks.ts'
import { createSeenRegistry } from '../../../lib/docs/seen.ts'
import { createDocStore, type DocHandle } from '../../../lib/docs/store.ts'
import type { ScreenSetup } from '../model/screenSetup.ts'
import {
  initScreensDoc,
  LOCAL_ORIGIN,
  snapshotScreens,
  type ScreensSnapshot,
} from '../model/screensDoc.ts'

/**
 * The video module's doc store: one doc per screen map plus the shared index.
 *
 * This is the shared-doc primitive (docs/MODULES.md), and deliberately not
 * the box-owned settings the processor list uses. A screen map is crew
 * paperwork — where content lands, which input feeds which wall — and the
 * point is that every phone opens it offline. Nothing in it lets the box
 * put a packet anywhere, so the argument for keeping it out of a Yjs doc
 * does not apply.
 *
 * `moduleId` is 'video', so the rooms are `video/screens-<id>` and
 * `video/index`. The module had no documents before this; the index is new.
 */

export type { DocHandle }

export const DEFAULT_SCREENS_TITLE = 'Untitled screen map'

export const screensStore = createDocStore({
  moduleId: 'video',
  docName: (id) => `screens-${id}`,
  localOrigin: LOCAL_ORIGIN,
  defaultTitle: DEFAULT_SCREENS_TITLE,
  indexFields: (doc) => {
    const { meta, setup } = snapshotScreens(doc)
    return {
      title: meta.title || DEFAULT_SCREENS_TITLE,
      comp: setup ? `${setup.comp.w}×${setup.comp.h}` : '',
      screens: setup ? String(setup.screens.length) : '',
    }
  },
})

export const screensRoom = (id: string) => screensStore.room(id)

export const createScreens = (
  title: string,
  setup: ScreenSetup,
  sourceFile: string,
  by: string
): { id: string; handle: DocHandle } =>
  screensStore.create((doc: Y.Doc) => initScreensDoc(doc, { title, setup, sourceFile, by }))

export const deleteScreens = (id: string): Promise<void> => screensStore.remove(id)

export interface ScreensIndexEntry {
  id: string
  title: string
  comp: string
  screens: string
  lastModified: string
}

/** Open a screen map for the component's lifetime and render its live snapshot. */
export function useScreensDoc(id: string | null): {
  doc: Y.Doc | null
  snapshot: ScreensSnapshot | null
  loaded: boolean
} {
  const { doc, snapshot, loaded } = useStoreDoc(screensStore, id, snapshotScreens)
  return { doc, snapshot, loaded }
}

/** The screen-map index, merged with maps found only on this device. */
export function useScreensIndex(): { entries: ScreensIndexEntry[]; loaded: boolean } {
  const { entries, loaded } = useDocIndex(screensStore)
  return {
    entries: entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      comp: entry.meta.comp ?? '',
      screens: entry.meta.screens ?? '',
      lastModified: entry.lastModified,
    })),
    loaded,
  }
}

const seen = createSeenRegistry('crewbox:video-screens-seen')
export const markScreensSeen = seen.markSeen
export const useSeenScreens = seen.useSeen
