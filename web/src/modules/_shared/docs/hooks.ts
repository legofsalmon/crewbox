import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type * as Y from 'yjs'
import { snapshotIndex, type DocIndexEntry } from './indexDoc.ts'
import type { DocHandle, DocStore } from './store.ts'
import { syncManager, type RemotePeer, type SyncStatus } from './sync.ts'

/**
 * Subscribe a component to a Y.Doc, re-rendering (with a fresh computed
 * snapshot) on every doc update. `compute` must be referentially stable.
 */
export function useDocSnapshot<T>(doc: Y.Doc | null, compute: (doc: Y.Doc) => T): T | null {
  const cache = useRef<{ doc: Y.Doc; value: T } | null>(null)

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!doc) return () => {}
      const handler = () => {
        cache.current = { doc, value: compute(doc) }
        onStoreChange()
      }
      doc.on('update', handler)
      return () => doc.off('update', handler)
    },
    [doc, compute]
  )

  const getSnapshot = useCallback(() => {
    if (!doc) return null
    if (!cache.current || cache.current.doc !== doc) {
      cache.current = { doc, value: compute(doc) }
    }
    return cache.current.value
  }, [doc, compute])

  return useSyncExternalStore(subscribe, getSnapshot)
}

export interface OpenDoc<T> {
  doc: Y.Doc | null
  snapshot: T | null
  loaded: boolean
  undoManager: Y.UndoManager | null
}

/** Open a store's doc for the component's lifetime and render its live snapshot. */
export function useStoreDoc<T>(
  store: DocStore,
  id: string | null,
  compute: (doc: Y.Doc) => T
): OpenDoc<T> {
  const [handle, setHandle] = useState<DocHandle | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!id) {
      setHandle(null)
      setLoaded(false)
      return
    }
    let cancelled = false
    const h = store.open(id)
    setHandle(h)
    setLoaded(false)
    h.whenLoaded.then(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => {
      cancelled = true
      // The doc stays cached in the store for quick re-open; sync providers
      // and explicit deletion manage its real lifetime.
      setHandle(null)
    }
  }, [store, id])

  const doc = handle?.doc ?? null
  const snapshot = useDocSnapshot(doc, compute)
  return { doc, snapshot, loaded, undoManager: handle?.undoManager ?? null }
}

/**
 * A store's index, merged with docs found only in the local registry so a
 * selector still lists them before (or without) any sync.
 */
export function useDocIndex(store: DocStore): { entries: DocIndexEntry[]; loaded: boolean } {
  const [loaded, setLoaded] = useState(false)
  const [localIds, setLocalIds] = useState<string[]>([])
  const handle = store.openIndex()

  const compute = useCallback(
    (doc: Y.Doc) => snapshotIndex(doc, store.defaultTitle),
    [store.defaultTitle]
  )

  useEffect(() => {
    let cancelled = false
    handle.whenLoaded.then(() => {
      if (!cancelled) setLoaded(true)
    })
    setLocalIds(store.listLocalIds())
    return () => {
      cancelled = true
    }
  }, [store, handle])

  const entries = useDocSnapshot(handle.doc, compute) ?? []
  const known = new Set(entries.map((e) => e.id))
  const merged = [
    ...entries,
    ...localIds
      .filter((id) => !known.has(id))
      // Present but never synced or edited here: no index entry to name it.
      .map((id) => ({ id, title: `${store.defaultTitle} (local)`, lastModified: '', meta: {} })),
  ]
  return { entries: merged, loaded }
}

export const useSyncStatus = (): SyncStatus =>
  useSyncExternalStore(syncManager.subscribe, () => syncManager.status())

/** Devices (including this one) currently in the given room. */
export const useSyncPeers = (room: string): number =>
  useSyncExternalStore(syncManager.subscribe, () => syncManager.peers(room))

/** Remote peers (name, color, what they're editing) in the given room. */
export const useRemotePeers = (room: string): RemotePeer[] =>
  useSyncExternalStore(syncManager.subscribe, () => syncManager.remotePeers(room))
