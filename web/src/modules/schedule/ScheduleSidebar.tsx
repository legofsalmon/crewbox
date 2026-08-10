import { useEffect, useState } from 'react'
import { useStore } from '../../store.ts'
import { useAgendaActs } from './store/useAgenda.ts'
import { agenda, nowMinutes, relative } from './model/agenda.ts'

/** How often the countdowns move. Fine enough to trust, idle enough to ignore. */
const TICK_MS = 15_000

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
  const { acts } = useAgendaActs()
  const [now, setNow] = useState(() => nowMinutes(new Date()))

  useEffect(() => {
    const timer = setInterval(() => setNow(nowMinutes(new Date())), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const stages = agenda(acts, now)
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
            const countdown =
              playing?.endsIn != null
                ? `off ${relative(playing.endsIn)}`
                : upcoming?.startsIn != null
                  ? relative(upcoming.startsIn)
                  : 'done'
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
