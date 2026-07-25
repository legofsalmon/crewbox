import { useStore } from '../../store.ts'
import { useSheetIndex } from './store/hooks.ts'

const MAX_SIDEBAR_SHEETS = 8

/**
 * Patch Sheets sidebar section: the synced sheet index (most recently
 * edited first), then an "All sheets" row opening the full selector.
 */
export default function PatchSidebar() {
  const setActiveModule = useStore((s) => s.setActiveModule)
  const activeModuleId = useStore((s) => s.activeModuleId)
  const activeModuleSubpath = useStore((s) => s.activeModuleSubpath)
  const { entries } = useSheetIndex()

  const patchActive = activeModuleId === 'patch'
  const recent = entries.slice(0, MAX_SIDEBAR_SHEETS)

  return (
    <>
      <div className="section-head">
        <span>Patch Sheets</span>
        <button
          className="icon-btn"
          aria-label="All sheets"
          title="All sheets"
          onClick={() => setActiveModule('patch')}
        >
          +
        </button>
      </div>
      <ul>
        {recent.map((entry) => {
          const active = patchActive && activeModuleSubpath === `sheet/${entry.sheetId}`
          return (
            <li key={entry.sheetId}>
              <button
                className={`row ${active ? 'active' : ''}`}
                aria-label={`Open sheet ${entry.title}`}
                onClick={() => setActiveModule('patch', `sheet/${entry.sheetId}`)}
              >
                <span className="row-name">{entry.title}</span>
                {entry.stage && <span className="badge">{entry.stage}</span>}
              </button>
            </li>
          )
        })}
        <li>
          <button
            className={`row ${patchActive && !activeModuleSubpath ? 'active' : ''}`}
            onClick={() => setActiveModule('patch')}
          >
            <span className="row-name muted-note">All sheets…</span>
          </button>
        </li>
      </ul>
    </>
  )
}
