import { useMemo } from 'react'
import type * as Y from 'yjs'
import { useDocIndex, useRemotePeers, useStoreDoc, useSyncPeers } from '../../_shared/docs/hooks.ts'
import type { RemotePeer } from '../../_shared/docs/sync.ts'
import { findAddressConflicts, findOverruns, universeUsage } from '../model/addressing'
import { snapshotPlot } from '../model/plotDoc'
import type { PlotSnapshot } from '../model/types'
import { plotRoom, plotStore } from './docManager.ts'

export { useSyncStatus } from '../../_shared/docs/hooks.ts'
export type { RemotePeer, SyncStatus } from '../../_shared/docs/sync.ts'

export interface PlotIndexEntry {
  plotId: string
  title: string
  venue: string
  date: string
  lastModified: string
}

/** Open a plot for the component's lifetime and render its live snapshot. */
export function usePlot(plotId: string | null): {
  doc: Y.Doc | null
  snapshot: PlotSnapshot | null
  loaded: boolean
  undoManager: Y.UndoManager | null
} {
  return useStoreDoc(plotStore, plotId, snapshotPlot)
}

/** The plot index (selector list), merged with plots found only locally. */
export function usePlotIndex(): { entries: PlotIndexEntry[]; loaded: boolean } {
  const { entries, loaded } = useDocIndex(plotStore)
  return {
    entries: entries.map((entry) => ({
      plotId: entry.id,
      title: entry.title,
      venue: entry.meta.venue ?? '',
      date: entry.meta.date ?? '',
      lastModified: entry.lastModified,
    })),
    loaded,
  }
}

export interface PlotIssues {
  /** Fixture id → ids of fixtures whose DMX channels it overlaps. */
  conflicts: Map<string, string[]>
  /** Fixture ids whose footprint runs past channel 512. */
  overruns: Set<string>
  usage: ReturnType<typeof universeUsage>
  /** Fixtures with at least one problem. */
  affectedCount: number
}

/**
 * Addressing problems across the plot, recomputed when the fixture list
 * changes. Memoised on the fixtures array rather than the whole snapshot so
 * editing a purpose or a note doesn't redo the overlap scan.
 */
export function usePlotIssues(snapshot: PlotSnapshot | null): PlotIssues {
  const fixtures = snapshot?.fixtures
  return useMemo(() => {
    if (!fixtures) {
      return { conflicts: new Map(), overruns: new Set(), usage: [], affectedCount: 0 }
    }
    const conflicts = findAddressConflicts(fixtures)
    const overruns = new Set(findOverruns(fixtures))
    const affected = new Set([...conflicts.keys(), ...overruns])
    return {
      conflicts,
      overruns,
      usage: universeUsage(fixtures),
      affectedCount: affected.size,
    }
  }, [fixtures])
}

/** Devices (including this one) currently in the given plot's sync room. */
export const usePlotPeers = (plotId: string): number => useSyncPeers(plotRoom(plotId))

/** Remote peers (name, colour, what they're editing) in the plot's room. */
export const usePlotRemotePeers = (plotId: string): RemotePeer[] => useRemotePeers(plotRoom(plotId))
