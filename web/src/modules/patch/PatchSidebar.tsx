import { useStore } from '../../store.ts'

/** Placeholder sidebar section until the Live Patch port lands (Phase 3). */
export default function PatchSidebar() {
  const setActiveModule = useStore((s) => s.setActiveModule)
  const activeModuleId = useStore((s) => s.activeModuleId)
  return (
    <>
      <div className="section-head">
        <span>Patch Sheets</span>
      </div>
      <ul>
        <li>
          <button
            className={`row ${activeModuleId === 'patch' ? 'active' : ''}`}
            onClick={() => setActiveModule('patch')}
          >
            <span className="row-name">All sheets</span>
          </button>
        </li>
      </ul>
    </>
  )
}
