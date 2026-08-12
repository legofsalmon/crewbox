import { useStore } from '../../store.ts'

/**
 * Video sidebar: one row for now.
 *
 * LED is the first section rather than the only conceivable one — camera and
 * playback are the obvious neighbours — so this is a section head with a list
 * under it rather than a single row pretending to be the module.
 */
export default function VideoSidebar() {
  const setActiveModule = useStore((s) => s.setActiveModule)
  const activeModuleId = useStore((s) => s.activeModuleId)

  return (
    <>
      <div className="section-head">
        <span>Video</span>
      </div>
      <ul>
        <li>
          <button
            className={`row ${activeModuleId === 'video' ? 'active' : ''}`}
            aria-label="Open LED walls"
            onClick={() => setActiveModule('video')}
          >
            <span className="row-name">LED walls</span>
          </button>
        </li>
      </ul>
    </>
  )
}
