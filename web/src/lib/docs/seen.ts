import { useSyncExternalStore } from 'react'

/**
 * Which docs this device has seen, by last-viewed time — a sidebar shows an
 * "updated" dot when a doc's index lastModified is newer. Purely local
 * (localStorage): "seen" is a per-device notion, not shared state.
 */
export interface SeenRegistry {
  markSeen: (id: string) => void
  /** Live map of doc id → last-seen ISO time on this device. */
  useSeen: () => Record<string, string>
}

export function createSeenRegistry(storageKey: string): SeenRegistry {
  let cache: Record<string, string> | null = null
  const listeners = new Set<() => void>()

  function read(): Record<string, string> {
    if (cache) return cache
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
      cache = parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
    } catch {
      cache = {}
    }
    return cache
  }

  function subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  return {
    markSeen(id) {
      const next = { ...read(), [id]: new Date().toISOString() }
      cache = next
      try {
        localStorage.setItem(storageKey, JSON.stringify(next))
      } catch {
        // Best-effort; the dot is a hint, not state that can be wrong.
      }
      for (const fn of listeners) fn()
    },
    useSeen: () => useSyncExternalStore(subscribe, read),
  }
}
