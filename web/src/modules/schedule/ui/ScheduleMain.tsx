import { useEffect, useState } from 'react'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { useStore } from '../../../store.ts'
import { useAgendaActs } from '../store/useAgenda.ts'
import { agenda, nowMinutes, relative } from '../model/agenda.ts'
import styles from './Schedule.module.css'

/** How often the countdowns move. Fine enough to trust, idle enough to ignore. */
const TICK_MS = 15_000

/**
 * Now & Next — the running order, for everyone rather than for audio.
 *
 * Read standing up, usually on a phone, often in the dark, by someone who
 * wants one of two facts: what is on, and how long until the next thing.
 * Everything here is arranged around those two and nothing else. The full
 * day, the specs and the notes stay in Patch Sheets, where the people who
 * need that level of detail already are.
 */
export default function ScheduleMain() {
  const { acts, sheets, loaded } = useAgendaActs()
  const setActiveModule = useStore((s) => s.setActiveModule)
  const [now, setNow] = useState(() => nowMinutes(new Date()))

  useEffect(() => {
    const timer = setInterval(() => setNow(nowMinutes(new Date())), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const stages = agenda(acts, now)

  return (
    <div className={styles.schedule}>
      <header className={styles.hero}>
        <div className={styles.heroTop}>
          <DrawerButton />
          <h1>Running order</h1>
        </div>
        <p className={styles.sub}>
          What’s on and what’s next, from the patch sheets. Set times change there and land here.
        </p>
      </header>

      {stages.length === 0 ? (
        <div className={styles.empty}>
          {!loaded ? (
            <p>Loading…</p>
          ) : sheets === 0 ? (
            <>
              <p>No patch sheets on this box yet.</p>
              <p className={styles.emptyHint}>
                The running order comes from them — every act’s set times are already on the sheet
                audio builds, so nobody types the day twice.
              </p>
              <button className={styles.link} onClick={() => setActiveModule('patch')}>
                Open Patch Sheets
              </button>
            </>
          ) : (
            <>
              <p>No set times on the sheets yet.</p>
              <p className={styles.emptyHint}>
                Add start times to the acts in Patch Sheets and the running order fills itself in.
              </p>
            </>
          )}
        </div>
      ) : (
        <ul className={styles.stages}>
          {stages.map((stage) => (
            <li key={stage.stage} className={styles.stage}>
              <h2 className={styles.stageName}>{stage.stage}</h2>

              {stage.onNow ? (
                <div className={`${styles.slot} ${styles.onNow}`}>
                  <span className={styles.label}>On now</span>
                  <span className={styles.act}>{stage.onNow.act.name}</span>
                  {stage.onNow.endsIn !== null && (
                    <span className={styles.when}>
                      {stage.onNow.endsIn <= 0 ? 'over' : `off ${relative(stage.onNow.endsIn)}`}
                    </span>
                  )}
                </div>
              ) : (
                // Not an error, and not blank either: the gap between sets is
                // the busiest moment on a stage, and "nothing on" is the
                // answer someone is looking for.
                <div className={`${styles.slot} ${styles.gap}`}>
                  <span className={styles.label}>On now</span>
                  <span className={styles.act}>—</span>
                  <span className={styles.when}>
                    {stage.next ? 'changeover' : 'finished for the day'}
                  </span>
                </div>
              )}

              {stage.next && (
                <div className={styles.slot}>
                  <span className={styles.label}>Next</span>
                  <span className={styles.act}>{stage.next.act.name}</span>
                  <span className={styles.when}>
                    {stage.next.startsIn === null ? '' : relative(stage.next.startsIn)}
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
