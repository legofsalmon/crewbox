import type * as Y from 'yjs'
import { setMetaField } from '../model/sheetDoc'
import { displayToIso, isoToDisplay } from '../model/date'
import type { SheetSnapshot } from '../model/types'
import { downloadSheetCsv } from './download'
import { useDraft } from './useDraft'
import { useToasts } from './toastContext'
import styles from './Toolbar.module.scss'

export default function Toolbar({
  doc,
  snapshot,
  onOpenSubBoxes,
  onOpenLineup,
  onOpenVersions,
}: {
  doc: Y.Doc
  snapshot: SheetSnapshot
  onOpenSubBoxes: () => void
  onOpenLineup: () => void
  onOpenVersions: () => void
}) {
  const { addToast } = useToasts()

  const title = useDraft(snapshot.meta.title, (next) =>
    setMetaField(doc, 'title', next.trim() || 'Untitled Sheet')
  )
  const stage = useDraft(snapshot.meta.stage, (next) => setMetaField(doc, 'stage', next.trim()))
  const date = useDraft(isoToDisplay(snapshot.meta.date), (next) => {
    const iso = displayToIso(next)
    if (iso) {
      setMetaField(doc, 'date', iso)
    } else if (next.trim()) {
      addToast('Invalid date', 'Use DD/MM/YYYY — date left unchanged', 'warning')
    }
  })

  const handleExport = () => {
    downloadSheetCsv(snapshot)
    addToast('Export complete', 'Sheet downloaded as CSV', 'success')
  }

  return (
    <div className={styles.toolbar}>
      <div className={styles.titleSection}>
        <label className={styles.visuallyHidden} htmlFor="sheet-title">
          Sheet title
        </label>
        <input
          id="sheet-title"
          className={styles.titleInput}
          type="text"
          placeholder="Untitled Sheet"
          maxLength={100}
          {...title.inputProps}
        />
      </div>

      <div className={styles.metaSection}>
        <div className={styles.field}>
          <label htmlFor="sheet-stage">Stage:</label>
          <input
            id="sheet-stage"
            type="text"
            placeholder="Main Stage"
            maxLength={50}
            {...stage.inputProps}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="sheet-date">Date:</label>
          <input
            id="sheet-date"
            type="text"
            inputMode="numeric"
            placeholder="DD/MM/YYYY"
            maxLength={10}
            {...date.inputProps}
          />
        </div>
        <div className={styles.buttons}>
          <button type="button" onClick={onOpenSubBoxes}>
            Sub-Boxes
          </button>
          <button type="button" onClick={onOpenLineup}>
            Lineup
          </button>
          <button type="button" onClick={onOpenVersions}>
            Versions
          </button>
          <button type="button" className={styles.export} onClick={handleExport}>
            Export CSV
          </button>
        </div>
      </div>
    </div>
  )
}
