// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createDocStore } from './store.ts'
import { syncManager } from './sync.ts'
import { removeIndexEntry } from './indexDoc.ts'

/**
 * The lifecycle of an open document, which nothing was managing.
 *
 * Every `open` was kept for the life of the tab: a crew chief who looked at
 * ten sheets during a load-in held ten relay rooms, ten IndexedDB
 * connections, and an awareness entry in every one of them — a device that
 * appeared as company in every sheet it had ever glanced at and never left.
 */

const ORIGIN = Symbol('test')
let store: ReturnType<typeof createDocStore>
let n = 0

const newStore = () =>
  createDocStore({
    // A fresh module id per test: the store's registry key and its room names
    // are derived from it, and one test's registry must not be another's.
    moduleId: `test${n++}`,
    docName: (id) => `sheet-${id}`,
    localOrigin: ORIGIN,
    defaultTitle: 'Untitled Sheet',
    indexFields: (doc) => ({ title: String(doc.getMap('meta').get('title') ?? '') }),
  })

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  store = newStore()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Give a doc some content, the way a module's own edit would. */
const write = (doc: Y.Doc, title: string) =>
  doc.transact(() => doc.getMap('meta').set('title', title), ORIGIN)

describe('holding a document open', () => {
  it('keeps it while anybody is holding it, and lets go when nobody is', () => {
    const detach = vi.spyOn(syncManager, 'detach')
    const a = store.open('one')
    const b = store.open('one')
    expect(a.doc).toBe(b.doc)

    a.destroy()
    vi.advanceTimersByTime(60_000)
    expect(detach).not.toHaveBeenCalled()

    b.destroy()
    // Not immediately: navigating between two sheets unmounts one pane and
    // mounts the next, and tearing down a socket to rebuild it a moment
    // later is worse than holding it for a few seconds.
    expect(detach).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(detach).toHaveBeenCalledWith(store.room('one'))
  })

  it('cancels the teardown when it is reopened in time', () => {
    const detach = vi.spyOn(syncManager, 'detach')
    const first = store.open('one')
    write(first.doc, 'Main Stage')
    first.destroy()

    const again = store.open('one')
    vi.advanceTimersByTime(60_000)
    expect(detach).not.toHaveBeenCalled()
    // The same document, so what was typed is still there.
    expect(again.doc.getMap('meta').get('title')).toBe('Main Stage')
    again.destroy()
  })

  it('ignores a second release of the same hold', () => {
    // React cleanups and explicit closes both happen; a double release would
    // evict a document another pane is still using.
    const detach = vi.spyOn(syncManager, 'detach')
    const a = store.open('one')
    const b = store.open('one')
    a.destroy()
    a.destroy()
    vi.advanceTimersByTime(60_000)
    expect(detach).not.toHaveBeenCalled()
    b.destroy()
    vi.advanceTimersByTime(60_000)
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('leaves the room when the last person looking closes it', () => {
    // The other half of announce, which did not exist: peer counts, avatars
    // and "X is editing" markers stayed in every room this device had opened.
    const unannounce = vi.spyOn(syncManager, 'unannounce')
    const looking = store.open('one')
    const reader = store.open('one', { present: false })

    const detach = vi.spyOn(syncManager, 'detach')
    looking.destroy()
    expect(unannounce).toHaveBeenCalledWith(store.room('one'))
    // But still syncing, because the background reader still holds it.
    vi.advanceTimersByTime(60_000)
    expect(detach).not.toHaveBeenCalled()

    reader.destroy()
    vi.advanceTimersByTime(60_000)
    expect(detach).toHaveBeenCalledWith(store.room('one'))
  })

  it('does not leave while a second pane is still looking', () => {
    const unannounce = vi.spyOn(syncManager, 'unannounce')
    const a = store.open('one')
    const b = store.open('one')
    a.destroy()
    expect(unannounce).not.toHaveBeenCalled()
    b.destroy()
    expect(unannounce).toHaveBeenCalledTimes(1)
  })

  it('does not leave a document open for every one ever created', () => {
    // `create` hands its own hold back: no caller holds the returned handle,
    // they take the id and navigate.
    const detach = vi.spyOn(syncManager, 'detach')
    store.create((doc) => write(doc, 'New Sheet'))
    vi.advanceTimersByTime(60_000)
    expect(detach).toHaveBeenCalledTimes(1)
  })
})

describe('what this device remembers it has', () => {
  it('does not register a document that turned out to be empty', () => {
    // Following a link to a sheet that has been deleted, or one from a box
    // this device is not on, used to mint an empty document and list it as
    // "Untitled Sheet (local)" for ever — on a device whose owner had only
    // clicked a link.
    const handle = store.open('ghost')
    expect(store.listLocalIds()).toEqual([])
    handle.destroy()
  })

  it('registers one the moment it has content', () => {
    const handle = store.open('real')
    write(handle.doc, 'Main Stage')
    expect(store.listLocalIds()).toEqual(['real'])
    handle.destroy()
  })

  it('registers one whose content arrives from the relay', () => {
    // Not only this device's edits: a sheet that syncs down is a sheet this
    // device has, and the selector should list it without waiting for the
    // index.
    const elsewhere = new Y.Doc()
    elsewhere.getMap('meta').set('title', 'From another phone')

    const handle = store.open('remote')
    Y.applyUpdate(handle.doc, Y.encodeStateAsUpdate(elsewhere))
    expect(store.listLocalIds()).toEqual(['remote'])
    handle.destroy()
  })
})

describe('a document deleted on another device', () => {
  /**
   * Deleting the index row is not enough: every device merges its own local
   * registry back into the listing, so a sheet deleted on the desk vanished
   * from the index on every phone and came straight back on each of them as
   * "Untitled Sheet (local)" — un-deletable there, because what they were
   * listing was their own copy.
   */
  it('is dropped from this one, and does not come back', () => {
    const handle = store.open('doomed')
    write(handle.doc, 'Second Stage')
    handle.destroy()
    expect(store.listLocalIds()).toEqual(['doomed'])

    // What arrives from the other device: the row gone, a tombstone in its
    // place.
    removeIndexEntry(store.openIndex().doc, 'doomed', ORIGIN)

    expect(store.deleted().has('doomed')).toBe(true)
    expect(store.reconcileDeletions()).toEqual(['doomed'])
    expect(store.listLocalIds()).toEqual([])
  })

  it('leaves everything else alone', () => {
    const kept = store.open('kept')
    write(kept.doc, 'Main')
    kept.destroy()
    removeIndexEntry(store.openIndex().doc, 'somebody-elses', ORIGIN)
    expect(store.reconcileDeletions()).toEqual([])
    expect(store.listLocalIds()).toEqual(['kept'])
  })
})
