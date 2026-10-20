import { useStore } from '../../store.ts'

/**
 * Network sidebar section: the audit, and the map of what the box can see.
 * No index, no documents.
 */
export default function NetworkSidebar() {
  const setActiveModule = useStore((s) => s.setActiveModule)
  const activeModuleId = useStore((s) => s.activeModuleId)
  const activeModuleSubpath = useStore((s) => s.activeModuleSubpath)
  const here = activeModuleId === 'network'

  return (
    <>
      <div className="section-head">
        <span>Network</span>
      </div>
      <ul>
        <li>
          <button
            className="row"
            aria-current={here && activeModuleSubpath !== 'map' ? 'page' : undefined}
            aria-label="Open network audit"
            onClick={() => setActiveModule('network')}
          >
            <span className="row-name">Network audit</span>
          </button>
        </li>
        <li>
          <button
            className="row"
            aria-current={here && activeModuleSubpath === 'map' ? 'page' : undefined}
            aria-label="Open network map"
            onClick={() => setActiveModule('network', 'map')}
          >
            <span className="row-name">Network map</span>
          </button>
        </li>
      </ul>
    </>
  )
}
