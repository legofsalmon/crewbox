import { useStore } from '../../store.ts'
import { useScreensIndex, useSeenScreens } from './store/screensStore.ts'

const MAX_SIDEBAR_MAPS = 6

/**
 * Video sidebar: the LED walls the box watches, then the screen maps the
 * crew have imported (most recently changed first) and the full list.
 *
 * The + imports a map. It lands on the selector rather than opening the
 * file picker directly: a picker has to be opened from the click itself,
 * and by the time the selector has rendered that gesture is spent.
 */
export default function VideoSidebar() {
  const setActiveModule = useStore((s) => s.setActiveModule)
  const activeModuleId = useStore((s) => s.activeModuleId)
  const activeModuleSubpath = useStore((s) => s.activeModuleSubpath)
  const { entries } = useScreensIndex()
  const seen = useSeenScreens()

  const videoActive = activeModuleId === 'video'
  const recent = entries.slice(0, MAX_SIDEBAR_MAPS)

  return (
    <>
      <div className="section-head">
        <span>Video</span>
        <button
          className="icon-btn"
          aria-label="Import a screen map"
          title="Import a Resolume Advanced Output preset"
          onClick={() => setActiveModule('video', 'screens')}
        >
          +
        </button>
      </div>
      <ul>
        <li>
          <button
            className={`row ${videoActive && !activeModuleSubpath ? 'active' : ''}`}
            aria-label="Open LED walls"
            onClick={() => setActiveModule('video')}
          >
            <span className="row-name">LED walls</span>
          </button>
        </li>
        {recent.map((entry) => {
          const active = videoActive && activeModuleSubpath === `screens/${entry.id}`
          const updated =
            !active && !!entry.lastModified && entry.lastModified > (seen[entry.id] ?? '')
          return (
            <li key={entry.id}>
              <button
                className={`row ${active ? 'active' : ''}`}
                aria-label={`Open screen map ${entry.title}${updated ? ', updated' : ''}`}
                onClick={() => setActiveModule('video', `screens/${entry.id}`)}
              >
                <span className="row-name">{entry.title}</span>
                {entry.screens && <span className="badge">{entry.screens}</span>}
                {updated && (
                  <span className="updated-dot" title="Updated since you last opened it" />
                )}
              </button>
            </li>
          )
        })}
        <li>
          <button
            className={`row ${videoActive && activeModuleSubpath === 'screens' ? 'active' : ''}`}
            onClick={() => setActiveModule('video', 'screens')}
          >
            <span className="row-name muted-note">All screen maps…</span>
          </button>
        </li>
      </ul>
    </>
  )
}
