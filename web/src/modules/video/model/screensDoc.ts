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
 */
export const replaceSetup = (
  doc: Y.Doc,
  next: ScreenSetup,
  options: { sourceFile: string; by: string }
): void => {
  const { meta, setup } = getScreensRoots(doc)
  transact(doc, () => {
    setup.set('json', next)
    meta.set('sourceFile', options.sourceFile)
    meta.set('updatedAt', new Date().toISOString())
    meta.set('updatedBy', options.by)
  })
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

const isSetup = (v: unknown): v is ScreenSetup =>
  !!v &&
  typeof v === 'object' &&
  Array.isArray((v as ScreenSetup).screens) &&
  typeof (v as ScreenSetup).comp === 'object'

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
