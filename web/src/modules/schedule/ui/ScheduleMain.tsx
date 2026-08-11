import { useState } from 'react'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { useAgenda } from '../../../shell/timetable/hooks.ts'
import { relative } from '@crewbox/shared'
import { addAct, stagesIn } from '../../../shell/timetable/model.ts'
import { timetable } from '../../../shell/timetable/store.ts'
import ActEditor from './ActEditor.tsx'
import styles from './Schedule.module.css'

/**
 * The running order: what is on, what is next, and where it is edited.
 *
 * Read standing up, usually on a phone, often in the dark, by someone who
 * wants one of two facts — what is on, and how long until the next thing.
 * The board is arranged around those two and nothing else.
 *
 * Editing lives behind a toggle rather than beside every row. Far more
 * people read this than write it, and a screen full of inputs is a worse
 * answer to "who is on" than a screen full of answers.
 */
export default function ScheduleMain() {
  const { stages, acts, loaded } = useAgenda()
  const [editing, setEditing] = useState(false)

  const add = () => {
    // A new act inherits the stage already in use, because the common case is
    // adding the next band to a stage that exists rather than opening a new
    // one — and two spellings of the same stage name are two stages here.
    addAct(timetable().doc, { stage: stagesIn(acts)[0] ?? '' })
    setEditing(true)
  }

  return (
    <div className={styles.schedule}>
      <header className={styles.hero}>
        <div className={styles.heroTop}>
          <DrawerButton />
          <h1>Running order</h1>
          <div className={styles.heroActions}>
            <button
              className={styles.toggle}
              onClick={() => setEditing((on) => !on)}
              aria-pressed={editing}
            >
              {editing ? 'Done' : 'Edit'}
            </button>
          </div>
        </div>
        <p className={styles.sub}>
          Who’s on, where and when — shared with everyone on the box, and the one place it’s kept.
        </p>
      </header>

      {editing ? (
        <ActEditor acts={acts} onAdd={add} />
      ) : stages.length === 0 ? (
        <div className={styles.empty}>
          {!loaded ? (
            <p>Loading…</p>
          ) : (
            <>
              <p>No running order yet.</p>
              <p className={styles.emptyHint}>
                Add the acts once here and every department reads the same times — the patch sheets,
                the countdowns, and anything else that needs to know what’s on.
              </p>
              <button className={styles.link} onClick={add}>
                Add the first act
              </button>
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
