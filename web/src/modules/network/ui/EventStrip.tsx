import type { AuditEvent } from '../model/types.ts'
import styles from './EventStrip.module.scss'

/**
 * The last 24 hours as a strip, one tick per event — the "it was fine until
 * 17:40" picture. Ticks are positioned by time and coloured by what the
 * event was; the list below carries the words for anyone (and any screen
 * reader) that wants them.
 */

const STRIP_HOURS = 24

/** Which events read as faults (red) vs changes worth a glance (amber). */
const FAULT_KINDS = new Set(['dmx.outage', 'dmx.sync.frozen', 'watch.dark', 'media.device.gone'])

const clock = (at: number): string => new Date(at).toTimeString().slice(0, 5)

export default function EventStrip({ events, now }: { events: AuditEvent[]; now: number }) {
  const from = now - STRIP_HOURS * 60 * 60_000
  const visible = events.filter((e) => e.at >= from)
  const position = (at: number): string => `${(((at - from) / (now - from)) * 100).toFixed(2)}%`

  return (
    <section className={styles.strip} aria-label="Events, last 24 hours">
      <div className={styles.track}>
        {visible.map((event) => (
          <span
            key={event.id}
            className={`${styles.tick} ${FAULT_KINDS.has(event.kind) ? styles.fault : styles.change}`}
            style={{ left: position(event.at) }}
            title={`${clock(event.at)} — ${event.detail}`}
          />
        ))}
      </div>
      <div className={styles.axis}>
        <span>{clock(from)}</span>
        <span>now</span>
      </div>
      {visible.length > 0 ? (
        <ul className={styles.list}>
          {visible.slice(0, 8).map((event) => (
            <li key={event.id}>
              <span className={styles.time}>{clock(event.at)}</span> {event.detail}
            </li>
          ))}
          {visible.length > 8 && (
            <li className={styles.more}>and {visible.length - 8} more in the export</li>
          )}
        </ul>
      ) : (
        <p className={styles.quiet}>No events in the last 24 hours — a quiet network.</p>
      )}
    </section>
  )
}
