import { createSeenRegistry } from '../../../lib/docs/seen.ts'

/**
 * Which sheets this device has seen, by last-viewed time — the sidebar shows
 * an "updated" dot when a sheet's index lastModified is newer.
 */
const registry = createSeenRegistry('crewbox:patch-seen')

export const markSheetSeen = registry.markSeen
export const useSeenSheets = registry.useSeen
