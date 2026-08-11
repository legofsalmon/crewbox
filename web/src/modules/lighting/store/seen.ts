import { createSeenRegistry } from '../../../lib/docs/seen.ts'

/**
 * Which plots this device has seen — the sidebar shows an "updated" dot
 * when a plot's index lastModified is newer.
 */
const registry = createSeenRegistry('crewbox:lighting-seen')

export const markPlotSeen = registry.markSeen
export const useSeenPlots = registry.useSeen
