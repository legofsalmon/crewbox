import { useStore } from '../../store.ts'
import { useAgenda } from '../../shell/timetable/hooks.ts'
import { stageCountdown } from './model/countdown.ts'

/** Four fits a phone sidebar without scrolling; the module has the rest. */
const MAX_SIDEBAR_STAGES = 4

/**
 * Schedule's sidebar section: what is on right now, without opening anything.
 *
 * This is the whole argument for the module in one row. A stage manager who
 * never opens Schedule still gets "Headliner · Main · off in 20" beside the
 * channel list, because that is the fact they were going to ask someone for.
 */
export default function ScheduleSidebar() {
  const setActiveModule = useStore((s) => s.setActiveModule)
  const activeModuleId = useStore((s) => s.activeModuleId)
  const { stages } = useAgenda()
  const active = activeModuleId === 'schedule'

  return (
    <>
      <div className="section-head">
        <span>Running order</span>
      </div>
      <ul>
        {stages.length === 0 ? (
          <li>
            <button
              className={`row ${active ? 'active' : ''}`}
              onClick={() => setActiveModule('schedule')}
            >
              <span className="row-name muted-note">Now &amp; Next</span>
            </button>
          </li>
        ) : (
          stages.slice(0, MAX_SIDEBAR_STAGES).map((stage) => {
            const playing = stage.onNow
            const upcoming = stage.next
            const who = playing?.act.name ?? upcoming?.act.name ?? '—'
            const countdown = stageCountdown(stage)
            return (
              <li key={stage.stage}>
                <button
                  className={`row ${active ? 'active' : ''}`}
                  aria-label={`${stage.stage}: ${who}, ${countdown}`}
                  onClick={() => setActiveModule('schedule')}
                >
                  <span className="row-name">{who}</span>
                  <span className="badge">{stage.stage}</span>
                  <span className="muted-note">{countdown}</span>
                </button>
              </li>
            )
          })
        )}
      </ul>
    </>
  )
}
