import { useEffect } from 'react'
import { useStore } from '../../store.ts'
import PlotSelector from './ui/PlotSelector.tsx'
import PlotView from './ui/PlotView.tsx'
import { markPlotSeen } from './store/seen.ts'

/**
 * The lighting module's main pane, routed by subpath: the plot selector at
 * /m/lighting, a plot at /m/lighting/plot/<id>. Navigation goes through the
 * shell, so plots are deep-linkable and survive reloads.
 */
export default function LightingMain({ subpath }: { subpath: string }) {
  const setActiveModule = useStore((s) => s.setActiveModule)

  const plotId = subpath.startsWith('plot/') ? subpath.slice('plot/'.length) : null

  useEffect(() => {
    if (!plotId) return
    markPlotSeen(plotId)
    return () => markPlotSeen(plotId)
  }, [plotId])

  if (plotId) {
    return <PlotView plotId={plotId} onClose={() => setActiveModule('lighting')} />
  }
  return <PlotSelector onOpen={(id) => setActiveModule('lighting', `plot/${id}`)} />
}
