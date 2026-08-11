import { inRunningOrder } from '@crewbox/shared'
import { removeAct, updateAct, type Act } from '../../../shell/timetable/model.ts'
import { timetable } from '../../../shell/timetable/store.ts'
import styles from './Schedule.module.css'

/**
 * Where the running order is actually populated.
 *
 * Every field commits as it is typed. There is no save button because there
 * is nobody to save to — the timetable is a shared document, so an edit is
 * already on every other device by the time a finger leaves the key. A save
 * button would be a lie about that, and worse, a way to lose a set time by
 * walking away from a screen.
 *
 * Sorted by day and clock rather than by entry order, because the thing
 * being edited is a running order and a running order out of order is very
 * hard to check against the printed one. It is the same ordering the patch
 * sheets lay their columns out in — one definition, so the two cannot
 * disagree — which also puts a just-added, timeless act at the bottom, where
 * the finger that added it already is.
 */
export default function ActEditor({ acts, onAdd }: { acts: Act[]; onAdd: () => void }) {
  const doc = timetable().doc
  const set = (id: string, field: keyof Omit<Act, 'id'>, value: string | number) =>
    updateAct(doc, id, { [field]: value })

  const ordered = inRunningOrder(acts)

  return (
    <div className={styles.editor}>
      {ordered.map((act) => (
        <div key={act.id} className={styles.row}>
          <label className={styles.fieldWide}>
            <span>Act</span>
            <input
              value={act.name}
              placeholder="Band or act"
              onChange={(e) => set(act.id, 'name', e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Stage</span>
            <input
              value={act.stage}
              placeholder="Main"
              // A datalist rather than a select: stages come from what has
              // been typed, and a new one must not need a settings screen.
              list="crewbox-stages"
              onChange={(e) => set(act.id, 'stage', e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Date</span>
            <input
              type="date"
              value={act.date}
              onChange={(e) => set(act.id, 'date', e.target.value)}
            />
          </label>
          <label className={styles.fieldNarrow}>
            <span>On</span>
            <input
              type="time"
              value={act.start}
              onChange={(e) => set(act.id, 'start', e.target.value)}
            />
          </label>
          <label className={styles.fieldNarrow}>
            <span>Off</span>
            <input
              type="time"
              value={act.end}
              onChange={(e) => set(act.id, 'end', e.target.value)}
            />
          </label>
          <button
            className={styles.remove}
            aria-label={`Remove ${act.name || 'this act'}`}
            title="Remove"
            onClick={() => removeAct(doc, act.id)}
          >
            ×
          </button>
        </div>
      ))}

      {/* Shared by every stage input above. */}
      <datalist id="crewbox-stages">
        {[...new Set(acts.map((a) => a.stage).filter(Boolean))].map((stage) => (
          <option key={stage} value={stage} />
        ))}
      </datalist>

      <button className={styles.addAct} onClick={onAdd}>
        + Add act
      </button>
      <p className={styles.editorHint}>
        Changes are shared as you type — everyone on the box sees them straight away.
      </p>
    </div>
  )
}
