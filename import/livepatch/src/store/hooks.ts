import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type * as Y from 'yjs'
import { snapshotSheet } from '../model/sheetDoc'
import { snapshotIndex } from '../model/indexDoc'
import type { SheetIndexEntry, SheetSnapshot } from '../model/types'
import { listLocalSheetIds, openIndex, openSheet, type DocHandle } from './docManager'

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

/** Open a sheet doc for the component's lifetime and render its live snapshot. */
export function useSheet(sheetId: string | null): {
  doc: Y.Doc | null
  snapshot: SheetSnapshot | null
  loaded: boolean
  undoManager: Y.UndoManager | null
} {
  const [handle, setHandle] = useState<DocHandle | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!sheetId) {
      setHandle(null)
      setLoaded(false)
      return
    }
    let cancelled = false
    const h = openSheet(sheetId)
    setHandle(h)
    setLoaded(false)
    h.whenLoaded.then(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => {
      cancelled = true
      // The doc stays cached in the manager for quick re-open; sync providers
      // and explicit deletion manage its real lifetime.
      setHandle(null)
    }
  }, [sheetId])

  const doc = handle?.doc ?? null
  const snapshot = useDocSnapshot(doc, snapshotSheet)
  return { doc, snapshot, loaded, undoManager: handle?.undoManager ?? null }
}

/** The sheet index (selector list), merged with sheets found only locally. */
export function useSheetIndex(): { entries: SheetIndexEntry[]; loaded: boolean } {
  const [loaded, setLoaded] = useState(false)
  const [localOnlyIds, setLocalOnlyIds] = useState<string[]>([])
  const handle = openIndex()

  useEffect(() => {
    let cancelled = false
    handle.whenLoaded.then(() => {
      if (!cancelled) setLoaded(true)
    })
    listLocalSheetIds().then((ids) => {
      if (!cancelled) setLocalOnlyIds(ids)
    })
    return () => {
      cancelled = true
    }
  }, [handle])

  const entries = useDocSnapshot(handle.doc, snapshotIndex) ?? []
  const known = new Set(entries.map((e) => e.sheetId))
  const merged = [
    ...entries,
    ...localOnlyIds
      .filter((id) => !known.has(id))
      .map((sheetId) => ({
        sheetId,
        title: 'Untitled Sheet (local)',
        stage: '',
        date: '',
        lastModified: '',
      })),
  ]
  return { entries: merged, loaded }
}
