import { useMemo, useState, type FormEvent } from 'react'
import { MAX_CUE_LABEL, cueWhere, type Cue } from '@crewbox/shared'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { useAgenda } from '../../../shell/timetable/hooks.ts'
import { stagesIn } from '../../../shell/timetable/model.ts'
import { useStore } from '../../../store.ts'
import { useArmed } from '../../../lib/armed.ts'
import { answeredIn, clockTime, cueStatus, peopleToCue, splitCues } from '../model/cues.ts'
import styles from './Cues.module.css'

/**
 * Cue lights: call a standby to somebody, see them stand by, send GO.
 *
 * One job: get a silent cue to the person who does it, at the moment it is
 * due. The form is above the lamps because the next cue is set up while the
 * last one is live, and the live lamps sit where the caller's thumb is.
 * History is below and quiet: it is what the show report asks for later,
 * not what anybody needs mid-cue.
 */
export default function CuesMain() {
  const cues = useStore((s) => s.cues)
  const connection = useStore((s) => s.connection)

  return (
    <div className={styles.cues}>
      <header className={styles.hero}>
        <div className={styles.heroTop}>
          <DrawerButton />
          <h1>Cue lights</h1>
        </div>
        <p className={styles.sub}>
          Call a standby to the person doing the cue. Their phone lights up and buzzes, they say
          they’re standing by, and you send GO. No talking needed.
        </p>
      </header>

      {cues === null ? (
        <div className={styles.empty}>
          <p>This box doesn’t have cue lights.</p>
          <p className={styles.hint}>They need the box on crewbox 1.5 or later.</p>
        </div>
      ) : (
        <>
          <CallForm offline={connection !== 'online'} />
          <Lamps cues={cues} />
        </>
      )}
    </div>
  )
}

function CallForm({ offline }: { offline: boolean }) {
  const users = useStore((s) => s.users)
  const online = useStore((s) => s.online)
  const me = useStore((s) => s.me)
  const callStandby = useStore((s) => s.callStandby)
  const toast = useStore((s) => s.toast)
  const { acts } = useAgenda()
  const stages = useMemo(() => stagesIn(acts), [acts])
  const people = useMemo(() => peopleToCue(users, online, me?.id), [users, online, me?.id])

  const [targetId, setTargetId] = useState('')
  const [label, setLabel] = useState('')
  const [stage, setStage] = useState('')
  const chosen = people.some((p) => p.user.id === targetId) ? targetId : ''

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!chosen || !label.trim()) return
    if (!callStandby(chosen, label.trim(), stage)) {
      toast('Can’t reach the box, so the standby wasn’t sent. Use your radio.', 'error')
      return
    }
    // The label goes: the next cue is a new one. The person and stage stay,
    // because the next cue is usually theirs too.
    setLabel('')
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Call a standby">
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Who</span>
        <select value={chosen} onChange={(e) => setTargetId(e.target.value)} required>
          <option value="" disabled>
            Choose a person
          </option>
          {people.map(({ user, online: on }) => (
            <option key={user.id} value={user.id}>
              {on ? user.name : `${user.name} (offline)`}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Cue</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={MAX_CUE_LABEL}
          placeholder="Pyro 1"
          enterKeyHint="send"
          required
        />
      </label>
      {stages.length > 0 && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Stage</span>
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">No stage</option>
            {stages.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="submit"
        className={styles.primary}
        disabled={offline || !chosen || !label.trim()}
        title={offline ? 'Offline: a standby needs the box' : undefined}
      >
        Call standby
      </button>
      {offline && (
        <p className={styles.hint} role="status">
          Offline. A standby needs the box, so it is never queued to arrive late.
        </p>
      )}
    </form>
  )
}

function Lamps({ cues }: { cues: Cue[] }) {
  const { live, done } = splitCues(cues)
  return (
    <>
      <section className={styles.section} aria-labelledby="cues-live">
        <h2 id="cues-live" className={styles.sectionHead}>
          Live
        </h2>
        {live.length === 0 ? (
          <p className={styles.hint}>No standbys called.</p>
        ) : (
          <ul className={styles.list}>
            {live.map((cue) => (
              <LiveCue key={cue.id} cue={cue} />
            ))}
          </ul>
        )}
      </section>
      {done.length > 0 && (
        <section className={styles.section} aria-labelledby="cues-done">
          <h2 id="cues-done" className={styles.sectionHead}>
            Earlier
          </h2>
          <ul className={styles.history}>
            {done.map((cue) => (
              <li key={cue.id} className={styles.past}>
                <span className={styles.pastLabel}>{cue.label}</span>
                <span className={styles.pastWho}>{cue.target.name}</span>
                <span className={styles.pastWhat}>
                  {cueStatus(cue)} · {answeredIn(cue)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function LiveCue({ cue }: { cue: Cue }) {
  const cueStep = useStore((s) => s.cueStep)
  const toast = useStore((s) => s.toast)
  const online = useStore((s) => s.online[cue.target.id] === true)
  const step = (what: 'go' | 'stand-down') => {
    if (!cueStep(cue.id, what)) toast('Can’t reach the box. Use your radio.', 'error')
  }
  // GO to somebody who hasn't said they are standing by arms first: they may
  // not have seen it, and a cue that goes to an operator who isn't there is
  // the failure this whole thing exists to prevent. Once they are standing
  // by, GO is one press, because that is the moment timing matters.
  const unanswered = useArmed(() => step('go'))
  const ready = cue.state === 'ready'
  const where = cueWhere(cue)

  return (
    <li className={styles.lamp} data-state={cue.state}>
      <div className={styles.lampHead}>
        <span className={styles.lampLabel}>{cue.label}</span>
        <span className={styles.lampFor}>for {cue.target.name}</span>
      </div>
      <p className={styles.lampStatus} aria-live="polite">
        <span className={styles.dot} aria-hidden />
        {cueStatus(cue)}
        {!ready && !online ? ' (offline: their phone rings when it’s back)' : ''}
      </p>
      <p className={styles.lampMeta}>
        Called by {cue.caller.name} at {clockTime(cue.standbyAt)}
        {where ? ` · ${where}` : ''}
      </p>
      <div className={styles.lampActions}>
        {ready ? (
          <button className={styles.go} onClick={() => step('go')}>
            GO
          </button>
        ) : (
          <button className={styles.go} {...unanswered.props}>
            {unanswered.armed ? 'GO without standby?' : 'GO'}
          </button>
        )}
        <button className={styles.quiet} onClick={() => step('stand-down')}>
          Stand down
        </button>
      </div>
    </li>
  )
}
