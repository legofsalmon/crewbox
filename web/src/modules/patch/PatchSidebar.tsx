import { useStore } from '../../store.ts'
import { useSheetIndex } from './store/hooks.ts'
import { useSeenSheets } from './store/seen.ts'

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
  const seen = useSeenSheets()

  const patchActive = activeModuleId === 'patch'
  const recent = entries.slice(0, MAX_SIDEBAR_SHEETS)

  return (
    <>
      <div className="section-head">
        <span>Patch Sheets</span>
        {/* Not "All sheets": the row below the list already carries that
            name, and a screen reader announcing two different controls
            identically gives someone no way to tell them apart. The glyph is
            a +, so say what pressing it gets you. */}
        <button
          className="icon-btn"
          aria-label="Open patch sheets"
          title="Open patch sheets"
          onClick={() => setActiveModule('patch')}
        >
          +
        </button>
      </div>
      <ul>
        {recent.map((entry) => {
          const active = patchActive && activeModuleSubpath === `sheet/${entry.sheetId}`
          // Edited (by anyone, anywhere) since this device last had it open.
          const updated =
            !active && !!entry.lastModified && entry.lastModified > (seen[entry.sheetId] ?? '')
          return (
            <li key={entry.sheetId}>
              <button
                className={`row ${active ? 'active' : ''}`}
                aria-label={`Open sheet ${entry.title}${updated ? ', updated' : ''}`}
                onClick={() => setActiveModule('patch', `sheet/${entry.sheetId}`)}
              >
                <span className="row-name">{entry.title}</span>
                {entry.stage && <span className="badge">{entry.stage}</span>}
                {updated && (
                  <span className="updated-dot" title="Updated since you last opened it" />
                )}
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
