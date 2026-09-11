import * as Y from 'yjs'
import type { ScreenSetup } from './screenSetup.ts'

/**
 * Y.Doc structure for a screen map: one Advanced Output setup, as imported
 * from Arena, plus what the crew add on top of it.
 *
 * The setup itself is one value, replaced wholesale. It is machine-written —
 * nobody edits a slice's corners by hand in crewbox, and two people importing
 * different versions of the same preset at once is a last-writer-wins that
 * reads exactly like what happened. Everything a person types lives in its
 * own key so it merges: the title, and which processor input feeds each
 * screen. Feeds are keyed by screen *name* rather than Arena's uniqueId,
 * because the id changes when a preset is rebuilt and the name is what a
 * crew keeps.
 */

export const LOCAL_ORIGIN = 'video-screens-local'

export interface ScreensMeta {
  title: string
  sourceFile: string
  importedAt: string
  importedBy: string
  updatedAt: string
  updatedBy: string
}

/** Which processor input a screen is plugged into, as the crew told us. */
export interface Feed {
  processorId: string
  inputId: string
}

export interface ScreensSnapshot {
  meta: ScreensMeta
  setup: ScreenSetup | null
  feeds: Record<string, Feed>
}

export interface ScreensRoots {
  meta: Y.Map<unknown>
  setup: Y.Map<unknown>
  feeds: Y.Map<Feed>
}

export const getScreensRoots = (doc: Y.Doc): ScreensRoots => ({
  meta: doc.getMap('meta'),
  setup: doc.getMap('setup'),
  feeds: doc.getMap<Feed>('feeds'),
})

const transact = (doc: Y.Doc, fn: () => void) => doc.transact(fn, LOCAL_ORIGIN)

export interface InitScreensOptions {
  title: string
  setup: ScreenSetup
  sourceFile: string
  by: string
}

export const initScreensDoc = (doc: Y.Doc, options: InitScreensOptions): void => {
  const { meta, setup } = getScreensRoots(doc)
  const now = new Date().toISOString()
  transact(doc, () => {
    meta.set('title', options.title)
    meta.set('sourceFile', options.sourceFile)
    meta.set('importedAt', now)
    meta.set('importedBy', options.by)
    meta.set('updatedAt', now)
    meta.set('updatedBy', options.by)
    setup.set('json', options.setup)
  })
}

/**
 * A newer version of the same setup — a re-import, or a change Arena saved
 * while somebody was watching the file. Keeps the title and the feeds.
 *
 * Returns whether anything was actually written, and **skips the write when
 * the setup is unchanged**, which is load-bearing rather than tidy. Arena
 * rewrites `Preferences/AdvancedOutput.xml` on any preference change, not
 * only on a screen edit, so the file watcher offers this the same setup over
 * and over. A `Y.Map` write keeps every superseded value in the update log:
 * at ~100 KB for a 215-slice setup, about eighty identical saves would push
 * the room past the relay's `MAX_ROOM_BYTES` (`server/src/docs.ts`), after
 * which `roomIsFull` stops syncing it — silently, with the pane still saying
 * "watching". Every phone would also be downloading that whole history.
 *
 * `updatedAt` is deliberately inside the same guard: bumping it on every
 * no-op save would churn the doc just as surely, three small writes at a
 * time, and would claim the map changed when it did not.
 */
export const replaceSetup = (
  doc: Y.Doc,
  next: ScreenSetup,
  options: { sourceFile: string; by: string }
): boolean => {
  const { meta, setup } = getScreensRoots(doc)
  const current = setup.get('json')
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(next)) return false
  transact(doc, () => {
    setup.set('json', next)
    meta.set('sourceFile', options.sourceFile)
    meta.set('updatedAt', new Date().toISOString())
    meta.set('updatedBy', options.by)
  })
  return true
}

export const setScreensTitle = (doc: Y.Doc, title: string): void => {
  const { meta } = getScreensRoots(doc)
  transact(doc, () => meta.set('title', title))
}

/** Record (or clear, with `null`) which processor input feeds a screen. */
export const setFeed = (doc: Y.Doc, screenName: string, feed: Feed | null): void => {
  const { feeds } = getScreensRoots(doc)
  transact(doc, () => {
    if (feed) feeds.set(screenName, feed)
    else feeds.delete(screenName)
  })
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Is this really a `ScreenSetup`?
 *
 * This is a trust boundary, not a formality. The value arrives from the relay
 * — written by another device, on a build that may be older or newer than
 * this one — or out of IndexedDB, where it may have been truncated. The
 * builders downstream are written for a setup their own parser produced:
 * `buildView` does `screen.layers.map(...)` and `meshBoundary` indexes
 * `verts[j * cols + i]!` with a non-null assertion. Checking only that
 * `screens` is an array let a missing `layers` reach both.
 *
 * That is worse here than a blank pane, because there is no error boundary
 * anywhere in `web/src`: a throw during render unmounts the whole app, and
 * the crew member loses chat, the running order and anything unsent along
 * with the map. So the shape is checked to the depth the builders index —
 * including the mesh invariant `verts.length === cols * rows`, which is the
 * one they assert rather than test.
 *
 * Unknown *extra* fields are fine and deliberately not rejected: a newer
 * build adding one must not blank the map on an older one.
 */
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isPts = (v: unknown): boolean =>
  Array.isArray(v) && v.every((p) => isObj(p) && typeof p.x === 'number' && typeof p.y === 'number')

const isRect = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (isObj(v) && isPts(v.pts) && typeof v.w === 'number' && typeof v.h === 'number' && isObj(v.bbox))

const isWarp = (v: unknown): boolean => {
  if (v === null || v === undefined) return true
  if (!isObj(v)) return false
  const { cols, rows, verts } = v
  if (typeof cols !== 'number' || typeof rows !== 'number' || !isPts(verts)) return false
  // meshBoundary walks the grid with a non-null assertion, so the product has
  // to match the vertex count exactly — an off-by-one here is a thrown
  // TypeError several frames deep.
  return cols >= 2 && rows >= 2 && (verts as unknown[]).length === cols * rows
}

const isLayer = (v: unknown): boolean =>
  isObj(v) &&
  typeof v.name === 'string' &&
  typeof v.kind === 'string' &&
  isRect(v.input) &&
  isRect(v.output) &&
  isWarp(v.warp) &&
  (v.contour === null || v.contour === undefined || (isObj(v.contour) && isPts(v.contour.points)))

const isScreen = (v: unknown): boolean =>
  isObj(v) &&
  typeof v.name === 'string' &&
  Array.isArray(v.layers) &&
  v.layers.every(isLayer) &&
  (v.device === null || v.device === undefined || isObj(v.device))

const isSetup = (v: unknown): v is ScreenSetup =>
  isObj(v) &&
  Array.isArray(v.screens) &&
  v.screens.every(isScreen) &&
  isObj(v.comp) &&
  typeof v.comp.w === 'number' &&
  typeof v.comp.h === 'number'

export const snapshotScreens = (doc: Y.Doc): ScreensSnapshot => {
  const { meta, setup, feeds } = getScreensRoots(doc)
  const json = setup.get('json')
  const feedsOut: Record<string, Feed> = {}
  for (const [name, feed] of feeds.entries()) {
    if (feed && typeof feed.processorId === 'string') feedsOut[name] = feed
  }
  return {
    meta: {
      title: str(meta.get('title')),
      sourceFile: str(meta.get('sourceFile')),
      importedAt: str(meta.get('importedAt')),
      importedBy: str(meta.get('importedBy')),
      updatedAt: str(meta.get('updatedAt')),
      updatedBy: str(meta.get('updatedBy')),
    },
    setup: isSetup(json) ? json : null,
    feeds: feedsOut,
  }
}
