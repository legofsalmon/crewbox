import type { ProcessorStatus } from '@crewbox/shared'
import { STATE_LABELS, ago, detailOf, readPathLabel, shouldSuggestSnmp } from '../model/format.ts'
import styles from './ProcessorRow.module.scss'

/**
 * One processor.
 *
 * The name is the crew's — "upstage left" — and stays that way even once the
 * controller tells us it calls itself something else; that goes underneath.
 * Everything below the name is only what the box actually read, so a sparse
 * row means a quiet controller rather than a hidden failure.
 *
 * `armedBy` is shown because traffic on a show network should have a name
 * against it, not because anyone needs permission to put it there.
 */

const HEALTH_CLASS: Record<string, string> = {
  ok: styles.ok!,
  warn: styles.warn!,
  fault: styles.fault!,
  unknown: styles.unknown!,
}

export default function ProcessorRow({
  status,
  now,
  busy,
  onWatch,
  onStop,
  onRemove,
}: {
  status: ProcessorStatus
  now: number
  busy: boolean
  onWatch: () => void
  onStop: () => void
  onRemove: () => void
}) {
  const { processor, reading, state } = status
  const detail = detailOf(reading)

  return (
    <li className={styles.row}>
      <div className={styles.top}>
        <span
          className={`${styles.dot} ${state === 'listed' ? styles.idle! : (HEALTH_CLASS[status.health] ?? '')}`}
          aria-hidden="true"
        />
        <div className={styles.names}>
          <span className={styles.name}>{processor.name}</span>
          <span className={styles.host}>
            {processor.host}
            {reading?.reportedName && reading.reportedName !== processor.name && (
              <> · calls itself “{reading.reportedName}”</>
            )}
            {reading?.model && <> · {reading.model}</>}
          </span>
        </div>
        <span className={`${styles.state} ${state === 'listed' ? styles.stateIdle! : ''}`}>
          {STATE_LABELS[state]}
        </span>
      </div>

      <p className={styles.summary}>
        {status.summary}
        {detail && detail !== status.summary && <span className={styles.detail}> — {detail}</span>}
      </p>

      {state === 'listed' ? (
        <p className={styles.note}>
          The box has never contacted this address and will not until someone turns it on.
        </p>
      ) : (
        <p className={styles.meta}>
          Last heard {ago(status.lastHeard, now)} {readPathLabel(reading)}
        </p>
      )}

      {state === 'no-read-path' && (
        <p className={styles.note}>
          Nothing answered on 8001 or 161. Either there is no processor at this address, or it is a
          model whose only interface is the register bus — a VX4S or a NovaPro UHD Jr. crewbox
          cannot tell the two apart without opening a control session, which it will not do while
          somebody may be using the desk.
        </p>
      )}

      {shouldSuggestSnmp(status) && (
        <p className={styles.note}>
          SNMP is switched off on this controller, so the box is reading the HTTP API instead —
          fewer numbers, and no per-cabinet detail. Turning SNMP on is a change to the processor, so
          it has to be done at the front panel or in VMP.
        </p>
      )}

      {reading && reading.errors.length > 0 && (
        <p className={styles.errors}>Didn’t answer: {reading.errors.join('; ')}</p>
      )}

      {/* Open to anyone signed in: everything these start is an addressed
          GET, so a screens tech should not need to find an admin to look at
          their own wall. The sweep is the one privileged thing here. */}
      <div className={styles.actions}>
        {processor.monitored ? (
          <button className={styles.stop} onClick={onStop} disabled={busy}>
            Stop watching
          </button>
        ) : (
          <button className={styles.watch} onClick={onWatch} disabled={busy}>
            Watch this…
          </button>
        )}
        <button className={styles.remove} onClick={onRemove} disabled={busy}>
          Remove
        </button>
        {processor.armedBy && processor.monitored && (
          <span className={styles.who}>turned on by {processor.armedBy}</span>
        )}
      </div>
    </li>
  )
}
