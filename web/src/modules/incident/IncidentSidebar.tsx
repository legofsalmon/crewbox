import { useStore } from '../../store.ts'
import { INCIDENT_KIND_LABELS } from '@crewbox/shared'
import { inLogOrder, seriousCount } from './model/log.ts'

/**
 * The show log's sidebar row: the last thing that happened, and how bad.
 *
 * One row, like the running order's. A stage manager who never opens the pane
 * still sees "21:04 Show stop" beside the channel list, which is the fact
 * somebody was about to ask over comms — and the serious tally beside it is
 * the number a duty manager wants at a glance.
 */
export default function IncidentSidebar() {
  const setActiveModule = useStore((s) => s.setActiveModule)
  const activeModuleId = useStore((s) => s.activeModuleId)
  const incidents = useStore((s) => s.incidents)
  const active = activeModuleId === 'incident'

  const [latest] = inLogOrder(incidents)
  const serious = seriousCount(incidents)
  const when = latest
    ? new Date(latest.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  return (
    <>
      <div className="section-head">
        <span>Show log</span>
      </div>
      <ul>
        <li>
          <button
            className={`row ${active ? 'active' : ''}`}
            aria-label={
              latest
                ? `Show log: last entry ${when}, ${INCIDENT_KIND_LABELS[latest.kind]}`
                : 'Show log: nothing logged yet'
            }
            onClick={() => setActiveModule('incident')}
          >
            {latest ? (
              <>
                <span className="row-name">{INCIDENT_KIND_LABELS[latest.kind]}</span>
                <span className="muted-note">{when}</span>
              </>
            ) : (
              <span className="row-name muted-note">Nothing logged yet</span>
            )}
            {serious > 0 && (
              <span className="badge" aria-label={`${serious} serious`}>
                {serious}
              </span>
            )}
          </button>
        </li>
      </ul>
    </>
  )
}
