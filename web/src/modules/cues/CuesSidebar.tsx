import { isLiveCue } from '@crewbox/shared'
import { useStore } from '../../store.ts'

/**
 * The cue lights' sidebar row: how many standbys are live, and whether one
 * is yours. One row, like the show log's. The operator's own standby lights
 * the whole screen (components/CueLight.tsx), so this is for the caller.
 */
export default function CuesSidebar() {
  const setActiveModule = useStore((s) => s.setActiveModule)
  const active = useStore((s) => s.activeModuleId === 'cues')
  const cues = useStore((s) => s.cues)
  const meId = useStore((s) => s.me?.id)

  const live = (cues ?? []).filter(isLiveCue)
  const waiting = live.filter((cue) => cue.state === 'standby').length

  return (
    <>
      <div className="section-head">
        <span>Cue lights</span>
      </div>
      <ul>
        <li>
          <button
            className="row"
            aria-current={active ? 'page' : undefined}
            aria-label={
              live.length === 0
                ? 'Cue lights: none live'
                : `Cue lights: ${live.length} live, ${waiting} waiting for an answer`
            }
            onClick={() => setActiveModule('cues')}
          >
            {live.length === 0 ? (
              <span className="row-name muted-note">Call a standby</span>
            ) : (
              <>
                <span className="row-name">
                  {live.length === 1 ? live[0]!.label : `${live.length} standbys`}
                </span>
                {live.some((cue) => cue.target.id === meId) && (
                  <span className="muted-note">one for you</span>
                )}
                {waiting > 0 && <span className="badge">{waiting} waiting</span>}
              </>
            )}
          </button>
        </li>
      </ul>
    </>
  )
}
