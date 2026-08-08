import { useStore } from '../../store.ts'

/**
 * Network sidebar section: one row into the audit pane. No index, no
 * documents — the pane is the whole module.
 */
export default function NetworkSidebar() {
  const setActiveModule = useStore((s) => s.setActiveModule)
  const activeModuleId = useStore((s) => s.activeModuleId)

  return (
    <>
      <div className="section-head">
        <span>Network</span>
      </div>
      <ul>
        <li>
          <button
            className={`row ${activeModuleId === 'network' ? 'active' : ''}`}
            aria-label="Open network audit"
            onClick={() => setActiveModule('network')}
          >
            <span className="row-name">Network audit</span>
          </button>
        </li>
      </ul>
    </>
  )
}
