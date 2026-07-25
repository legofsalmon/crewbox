import { useSyncExternalStore } from 'react'

/**
 * Which sheets this device has seen, by last-viewed time — the sidebar shows
 * an "updated" dot when a sheet's index lastModified is newer. Purely local
 * (localStorage): "seen" is a per-device notion, not shared state.
 */
const SEEN_KEY = 'crewbox:patch-seen'

let cache: Record<string, string> | null = null
const listeners = new Set<() => void>()

function read(): Record<string, string> {
  if (cache) return cache
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
    cache = parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    cache = {}
  }
  return cache
}

export function markSheetSeen(sheetId: string): void {
  const next = { ...read(), [sheetId]: new Date().toISOString() }
  cache = next
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(next))
  } catch {
    // Best-effort; the dot is a hint, not state that can be wrong.
  }
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Live map of sheetId → last-seen ISO time on this device. */
export function useSeenSheets(): Record<string, string> {
  return useSyncExternalStore(subscribe, read)
}
