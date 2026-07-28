import { useStore } from '../../store.ts'
import { usePlotIndex } from './store/hooks.ts'
import { useSeenPlots } from './store/seen.ts'

const MAX_SIDEBAR_PLOTS = 8

/**
 * Lighting sidebar section: the synced plot index (most recently edited
 * first), then an "All plots" row opening the full selector.
 */
export default function LightingSidebar() {
  const setActiveModule = useStore((s) => s.setActiveModule)
  const activeModuleId = useStore((s) => s.activeModuleId)
  const activeModuleSubpath = useStore((s) => s.activeModuleSubpath)
  const { entries } = usePlotIndex()
  const seen = useSeenPlots()

  const lightingActive = activeModuleId === 'lighting'
  const recent = entries.slice(0, MAX_SIDEBAR_PLOTS)

  return (
    <>
      <div className="section-head">
        <span>Lighting</span>
        {/* See PatchSidebar: distinct from the "All plots…" row below, which
            goes to the same place but is a different control. */}
        <button
          className="icon-btn"
          aria-label="Open lighting plots"
          title="Open lighting plots"
          onClick={() => setActiveModule('lighting')}
        >
          +
        </button>
      </div>
      <ul>
        {recent.map((entry) => {
          const active = lightingActive && activeModuleSubpath === `plot/${entry.plotId}`
          const updated =
            !active && !!entry.lastModified && entry.lastModified > (seen[entry.plotId] ?? '')
          return (
            <li key={entry.plotId}>
              <button
                className={`row ${active ? 'active' : ''}`}
                aria-label={`Open plot ${entry.title}${updated ? ', updated' : ''}`}
                onClick={() => setActiveModule('lighting', `plot/${entry.plotId}`)}
              >
                <span className="row-name">{entry.title}</span>
                {entry.venue && <span className="badge">{entry.venue}</span>}
                {updated && (
                  <span className="updated-dot" title="Updated since you last opened it" />
                )}
              </button>
            </li>
          )
        })}
        <li>
          <button
            className={`row ${lightingActive && !activeModuleSubpath ? 'active' : ''}`}
            onClick={() => setActiveModule('lighting')}
          >
            <span className="row-name muted-note">All plots…</span>
          </button>
        </li>
      </ul>
    </>
  )
}
