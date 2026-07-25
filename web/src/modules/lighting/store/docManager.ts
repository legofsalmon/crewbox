import type * as Y from 'yjs'
import { createDocStore, type DocHandle } from '../../_shared/docs/store.ts'
import { createPlotUndoManager, getPlotRoots, initPlot, LOCAL_ORIGIN } from '../model/plotDoc'

/**
 * The lighting module's doc store — one doc per plot plus the shared index.
 * The lifecycle itself lives in _shared/docs; this is just configuration.
 */

export type { DocHandle }

export const DEFAULT_PLOT_TITLE = 'Untitled Plot'

export const plotStore = createDocStore({
  moduleId: 'lighting',
  docName: (id) => `plot-${id}`,
  localOrigin: LOCAL_ORIGIN,
  defaultTitle: DEFAULT_PLOT_TITLE,
  undoManager: createPlotUndoManager,
  indexFields: (doc) => {
    const { meta } = getPlotRoots(doc)
    return {
      title: (meta.get('title') as string) ?? DEFAULT_PLOT_TITLE,
      venue: (meta.get('venue') as string) ?? '',
      date: (meta.get('date') as string) ?? '',
    }
  },
})

/** Full relay room for a plot — what presence and peer counts are keyed by. */
export const plotRoom = (plotId: string) => plotStore.room(plotId)

export const openPlot = (plotId: string): DocHandle => plotStore.open(plotId)

export const createPlot = (title: string, venue = ''): { plotId: string; handle: DocHandle } => {
  const { id, handle } = plotStore.create((doc: Y.Doc) => initPlot(doc, { title, venue }))
  return { plotId: id, handle }
}

export const deletePlot = (plotId: string): Promise<void> => plotStore.remove(plotId)
