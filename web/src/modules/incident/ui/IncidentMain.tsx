import { useEffect, useMemo, useState } from 'react'
import {
  INCIDENT_KIND_LABELS,
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABELS,
  type Incident,
  type IncidentKind,
  type IncidentSeverity,
} from '@crewbox/shared'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { deliveredNote, deliverText } from '../../../lib/download.ts'
import { useStore } from '../../../store.ts'
import { byShowDay, clockOf, filterLog, loggedLate, type LogFilter } from '../model/log.ts'
import { reportFilename, showReportHtml } from '../model/report.ts'
import { queuedIncidents } from '../model/outbox.ts'
import LogEntryForm from './LogEntryForm.tsx'
import styles from './Incident.module.css'

/**
 * The show log.
 *
 * Read backwards, because the question is nearly always "what just
 * happened". Written rarely and urgently, so the button that opens the form
 * is the first thing in the header and the form defaults everything except
 * the words.
 *
 * Nothing here edits or deletes. A mistake is corrected by writing a
 * correction under it, and both stay — which is what makes this a record
 * rather than a shared document.
 */

const dayLabel = (day: string): string =>
  new Date(`${day}T12:00:00`).toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })

function Entry({
  entry,
  corrections,
  onCorrect,
}: {
  entry: Incident
  corrections: Incident[]
  onCorrect: (entry: Incident) => void
}) {
  const late = loggedLate(entry)
  const where = [entry.stage, entry.actName].filter(Boolean).join(' · ')

  return (
    <li className={`${styles.entry} ${styles[entry.severity]}`}>
      <div className={styles.entryHead}>
        <span className={styles.time}>{clockOf(entry.at)}</span>
        <span className={styles.kind}>{INCIDENT_KIND_LABELS[entry.kind]}</span>
        {entry.severity !== 'note' && (
          <span className={`${styles.sev} ${styles[`sev-${entry.severity}`]}`}>
            {INCIDENT_SEVERITY_LABELS[entry.severity]}
          </span>
        )}
        {where && <span className={styles.where}>{where}</span>}
      </div>
      <p className={styles.entryBody}>{entry.body}</p>
      <div className={styles.entryFoot}>
        <span>
          {entry.authorName || 'A crew member'}
          {/* Said out loud, because a note written twelve minutes later is a
              different kind of evidence from one written at the time. */}
          {late >= 2 ? ` · logged ${late} min later` : ''}
        </span>
        <button className={styles.correctBtn} onClick={() => onCorrect(entry)}>
          Add a correction
        </button>
      </div>
      {corrections.map((correction) => (
        <div key={correction.id} className={styles.correction}>
          <p className={styles.entryBody}>{correction.body}</p>
          <div className={styles.entryFoot}>
            <span>
              Correction at {clockOf(correction.at)}
              {correction.authorName ? ` · ${correction.authorName}` : ''}
            </span>
          </div>
        </div>
      ))}
    </li>
  )
}

export default function IncidentMain() {
  const incidents = useStore((s) => s.incidents)
  const loaded = useStore((s) => s.incidentsLoaded)
  const loadIncidents = useStore((s) => s.loadIncidents)
  const complete = useStore((s) => s.incidentsComplete)
  const loadEarlierIncidents = useStore((s) => s.loadEarlierIncidents)
  const loadWholeLog = useStore((s) => s.loadWholeLog)
  const eventName = useStore((s) => s.config.eventName)
  const toast = useStore((s) => s.toast)

  const [filing, setFiling] = useState(false)
  /** The report is paging the log; the button says so rather than hanging. */
  const [building, setBuilding] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [correcting, setCorrecting] = useState<Incident | null>(null)
  const [filter, setFilter] = useState<LogFilter>({})
  // Entries this device has filed and the box has not yet confirmed. Read
  // once per render rather than held in state: the queue is small, and the
  // socket acknowledgement is what removes them.
  const unsent = queuedIncidents().length

  useEffect(() => {
    void loadIncidents()
  }, [loadIncidents])

  const days = useMemo(() => byShowDay(filterLog(incidents, filter)), [incidents, filter])
  const stages = useMemo(
    () => [...new Set(incidents.map((e) => e.stage.trim()).filter(Boolean))],
    [incidents]
  )

  const download = async () => {
    /**
     * The whole night, not the last two hundred entries of it.
     *
     * The pane fetches one page and never paged, so a festival on its third
     * night produced a report that silently began partway through Friday —
     * a document that gets mailed on, with nothing in it saying it was a
     * fragment. Pages to the beginning first; on a box that cannot be
     * reached it exports what is held, which is what was happening before.
     */
    setBuilding(true)
    try {
      await loadWholeLog()
      const entries = useStore.getState().incidents
      const html = showReportHtml({ eventName, entries, generatedAt: Date.now() })
      const result = await deliverText(reportFilename(eventName, Date.now()), 'text/html', html)
      toast(deliveredNote(result, 'Show report'))
    } finally {
      setBuilding(false)
    }
  }

  return (
    <div className={styles.log}>
      <header className={styles.hero}>
        <div className={styles.heroTop}>
          <DrawerButton />
          <h1>Show log</h1>
          <div className={styles.heroActions}>
            <button
              className={styles.primary}
              onClick={() => {
                setCorrecting(null)
                setFiling((on) => !on)
              }}
              aria-pressed={filing}
            >
              {filing ? 'Close' : 'Log an entry'}
            </button>
            <button
              className={styles.secondary}
              onClick={() => void download()}
              disabled={!incidents.length || building}
            >
              {building ? 'Building…' : 'Show report'}
            </button>
          </div>
        </div>
        <p className={styles.sub}>
          What happened, when, and who wrote it down. Entries can’t be edited or deleted — a mistake
          is corrected underneath, and both stay.
        </p>
        {unsent > 0 && (
          <p className={styles.unsent} role="status">
            {unsent} {unsent === 1 ? 'entry is' : 'entries are'} waiting for the box. They’re held
            on this phone and go out as soon as it’s back.
          </p>
        )}
      </header>

      {(filing || correcting) && (
        <LogEntryForm
          {...(correcting ? { amends: { id: correcting.id, body: correcting.body } } : {})}
          onDone={() => {
            setFiling(false)
            setCorrecting(null)
          }}
        />
      )}

      {incidents.length > 0 && (
        <div className={styles.filters}>
          <select
            aria-label="Filter by kind"
            value={filter.kind ?? 'all'}
            onChange={(e) => setFilter((f) => ({ ...f, kind: e.target.value as IncidentKind }))}
          >
            <option value="all">Any kind</option>
            {INCIDENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {INCIDENT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by severity"
            value={filter.severity ?? 'all'}
            onChange={(e) =>
              setFilter((f) => ({ ...f, severity: e.target.value as IncidentSeverity }))
            }
          >
            <option value="all">Any severity</option>
            {INCIDENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {INCIDENT_SEVERITY_LABELS[s]}
              </option>
            ))}
          </select>
          {stages.length > 0 && (
            <select
              aria-label="Filter by stage"
              value={filter.stage ?? ''}
              onChange={(e) => setFilter((f) => ({ ...f, stage: e.target.value }))}
            >
              <option value="">Anywhere</option>
              {stages.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          )}
          <input
            type="search"
            aria-label="Search the log"
            placeholder="Search"
            value={filter.q ?? ''}
            onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
          />
        </div>
      )}

      {days.length === 0 ? (
        <div className={styles.empty}>
          {!loaded ? (
            <p>Loading…</p>
          ) : incidents.length === 0 ? (
            <>
              <p>Nothing logged yet.</p>
              <p className={styles.emptyHint}>
                Log the show stops, the holds, the near misses and the things that ran late. On the
                Monday it’s the show report; six months later it’s the only account anybody has.
              </p>
            </>
          ) : (
            <p>Nothing matches that filter.</p>
          )}
        </div>
      ) : (
        days.map((day) => (
          <section key={day.day} className={styles.day}>
            <h2 className={styles.dayHead}>{dayLabel(day.day)}</h2>
            <ul className={styles.entries}>
              {day.lines.map((line) => (
                <Entry
                  key={line.entry.id}
                  entry={line.entry}
                  corrections={line.corrections}
                  onCorrect={(entry) => {
                    setFiling(false)
                    setCorrecting(entry)
                  }}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {/*
        The log kept only the latest two hundred entries and never paged, so
        a third night began partway through Friday with nothing saying so.
      */}
      {loaded && incidents.length > 0 && !complete && (
        <div className={styles.earlier}>
          <button
            className={styles.secondary}
            disabled={loadingEarlier}
            onClick={() => {
              setLoadingEarlier(true)
              void loadEarlierIncidents().finally(() => setLoadingEarlier(false))
            }}
          >
            {loadingEarlier ? 'Loading…' : 'Load earlier entries'}
          </button>
        </div>
      )}
    </div>
  )
}
