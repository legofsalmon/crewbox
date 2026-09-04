import { useState, type FormEvent } from 'react'
import {
  INCIDENT_KIND_LABELS,
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABELS,
  MAX_INCIDENT_LENGTH,
  type IncidentKind,
  type IncidentSeverity,
} from '@crewbox/shared'
import { useAgenda } from '../../../shell/timetable/hooks.ts'
import { useStore } from '../../../store.ts'
import styles from './Incident.module.css'

/**
 * Filing an entry, one-handed, in the dark, while something is happening.
 *
 * Everything except the words has a sensible default, and the words are the
 * only required field: kind is a note, severity is a note, the stage is
 * whichever one the crew member last used, and the time is now. An entry
 * filed in four seconds with the wrong label beats a perfect one nobody had
 * time to write.
 *
 * The one control worth its space is "when". A stage manager deals with the
 * thing first and types it once there is a hand free, so the quick offsets
 * are there to say "this was ten minutes ago" without arithmetic.
 */

/** Minutes ago, as buttons, because nobody does subtraction at 2am. */
const QUICK_OFFSETS = [0, 5, 15, 30] as const

/**
 * The stage this crew member last filed against.
 *
 * The default was `stages[0]` — the agenda's first stage, which is not a
 * fact about this person and which *changes through the night* as acts come
 * and go. A stage manager who works one stage all weekend got a different
 * default every time they opened the form, and the whole point of the
 * defaults is that an entry filed in four seconds beats a perfect one
 * nobody had time to write. The header comment already claimed this
 * behaviour.
 *
 * Per device rather than per account: a phone belongs to a person, and the
 * box is not asked about something this small.
 */
const LAST_STAGE_KEY = 'crewbox:incident-stage'

const rememberedStage = (): string => {
  try {
    return localStorage.getItem(LAST_STAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

const rememberStage = (stage: string): void => {
  try {
    if (stage.trim()) localStorage.setItem(LAST_STAGE_KEY, stage.trim())
  } catch {
    // A browser with site data blocked. The form still works; it just does
    // not remember, which is where it started.
  }
}

const hhmm = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface LogEntryFormProps {
  /** Set when this entry corrects another; the form says so and links it. */
  amends?: { id: string; body: string }
  onDone: () => void
}

export default function LogEntryForm({ amends, onDone }: LogEntryFormProps) {
  const logIncident = useStore((s) => s.logIncident)
  const { stages } = useAgenda()

  const [kind, setKind] = useState<IncidentKind>('note')
  const [severity, setSeverity] = useState<IncidentSeverity>('note')
  const [stage, setStage] = useState(() => rememberedStage() || (stages[0]?.stage ?? ''))
  const [body, setBody] = useState('')
  const [offset, setOffset] = useState<number>(0)
  const [time, setTime] = useState('')

  /** What the entry will be stamped with: a typed time wins over an offset. */
  const at = (): number => {
    const now = Date.now()
    if (!time) return now - offset * 60_000
    const [h, m] = time.split(':').map(Number)
    if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return now
    const stamped = new Date()
    stamped.setHours(h, m, 0, 0)
    // A time later than now is one from before midnight — 23:50 typed at
    // 00:10 is twenty minutes ago, not twenty-three hours away.
    if (stamped.getTime() > now) stamped.setDate(stamped.getDate() - 1)
    return stamped.getTime()
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!body.trim()) return
    // What was on at the moment of filing, copied into the record on purpose:
    // the log has to keep saying "during Night Bus" after the running order
    // is corrected. See the Incident type in shared.
    const onStage = stages.find((s) => s.stage === stage)?.onNow?.act
    // Before the form closes: the next entry from this device defaults here.
    rememberStage(stage)
    logIncident({
      kind,
      severity,
      body,
      at: at(),
      stage,
      actId: onStage?.id ?? '',
      actName: onStage?.name ?? '',
      ...(amends ? { amends: amends.id } : {}),
    })
    onDone()
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      {amends && (
        <p className={styles.amending}>
          Correcting: <q>{amends.body}</q>
        </p>
      )}

      <label className={styles.label} htmlFor="incident-body">
        What happened
      </label>
      <textarea
        id="incident-body"
        className={styles.body}
        value={body}
        maxLength={MAX_INCIDENT_LENGTH}
        rows={3}
        autoFocus
        placeholder="Show stopped — wind reading over limit, crowd held at the barrier"
        onChange={(e) => setBody(e.target.value)}
      />

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="incident-kind">
            Kind
          </label>
          <select
            id="incident-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as IncidentKind)}
          >
            {INCIDENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {INCIDENT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="incident-severity">
            How bad
          </label>
          <select
            id="incident-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as IncidentSeverity)}
          >
            {INCIDENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {INCIDENT_SEVERITY_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="incident-stage">
            Where
          </label>
          <input
            id="incident-stage"
            list="incident-stages"
            value={stage}
            placeholder="Main Stage"
            maxLength={80}
            onChange={(e) => setStage(e.target.value)}
          />
          {/* The stages already on the running order, offered rather than
              retyped: "Main Stage" and "Main stage" are two stages to a
              computer and one to a crew. */}
          <datalist id="incident-stages">
            {stages.map((s) => (
              <option key={s.stage} value={s.stage} />
            ))}
          </datalist>
        </div>
      </div>

      <div className={styles.when}>
        <span className={styles.label}>When</span>
        {QUICK_OFFSETS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className={`${styles.quick} ${!time && offset === minutes ? styles.quickOn : ''}`}
            aria-pressed={!time && offset === minutes}
            onClick={() => {
              setOffset(minutes)
              setTime('')
            }}
          >
            {minutes === 0 ? 'Now' : `${minutes} min ago`}
          </button>
        ))}
        <input
          type="time"
          aria-label="Exact time it happened"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
        <span className={styles.stamp}>Stamped {hhmm(at())}</span>
      </div>

      <div className={styles.formActions}>
        <button type="submit" className={styles.primary} disabled={!body.trim()}>
          {amends ? 'File the correction' : 'Log it'}
        </button>
        <button type="button" className={styles.secondary} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}
