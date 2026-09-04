import type { RefObject } from 'react'
import type * as Y from 'yjs'
import { useStageNames } from '../../../shell/timetable/hooks.ts'
import { timetable } from '../../../shell/timetable/store.ts'
import { setMetaField } from '../model/sheetDoc'
import { setSheetDate, setSheetStage } from '../model/lineup'
import { displayToIso, isoToDisplay } from '../model/date'
import type { SheetAct, SheetSnapshot } from '../model/types'
import { NO_DOWNLOADS } from '../../../lib/download.ts'
import { downloadSheetCsv } from './download'
import { useDraft } from '../../_shared/ui/useDraft'
import { useToasts } from './toastContext'
import styles from './Toolbar.module.scss'

/** Undo state, owned by SheetView because the keyboard shortcuts are too. */
type History = {
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
}

/** Find-in-sheet. SheetView owns the query so Cmd+F can focus this input. */
type Search = {
  ref: RefObject<HTMLInputElement | null>
  query: string
  matchCount: number
  onChange: (next: string) => void
  onEnter: () => void
}

export default function Toolbar({
  doc,
  snapshot,
  acts,
  onOpenSubBoxes,
  onOpenStagePatch,
  onOpenLineup,
  onOpenVersions,
  onShare,
  history,
  search,
}: {
  doc: Y.Doc
  snapshot: SheetSnapshot
  acts: SheetAct[]
  onOpenSubBoxes: () => void
  onOpenStagePatch: () => void
  onOpenLineup: () => void
  onOpenVersions: () => void
  onShare: () => void
  history: History
  search: Search
}) {
  const { addToast } = useToasts()
  const stageNames = useStageNames()

  // The acts move with the name: the stage is how the sheet finds its
  // columns, so a rename on its own would empty the grid and say nothing.
  const stage = useDraft(snapshot.meta.stage, (next) => {
    setSheetStage(timetable().doc, snapshot.meta, acts, next)
    setMetaField(doc, 'stage', next.trim())
  })
  // The acts move with the date for the same reason they move with the
  // stage: between them those two fields are how the sheet finds its
  // columns, so changing one on its own empties the grid and says nothing.
  const date = useDraft(isoToDisplay(snapshot.meta.date), (next) => {
    const iso = displayToIso(next)
    if (iso) {
      setSheetDate(timetable().doc, snapshot.meta, acts, iso)
      setMetaField(doc, 'date', iso)
    } else if (next.trim()) {
      addToast('Invalid date', 'Use DD/MM/YYYY — date left unchanged', 'warning')
    }
  })

  const handleExport = () => {
    if (downloadSheetCsv(snapshot, acts)) {
      addToast('Export complete', 'Sheet downloaded as CSV', 'success')
    } else {
      addToast('Cannot save here', NO_DOWNLOADS, 'warning')
    }
  }

  return (
    <div className={styles.toolbar}>
      <div className={styles.field}>
        {/* Load-bearing, not decorative: the stage is how this sheet picks
            its acts out of the event's running order. Renaming it brings
            this sheet's acts along; the names already in use are offered
            back, because "Main Stage" where the running order says "Main"
            is a second stage and an empty grid. */}
        <label htmlFor="sheet-stage">Stage:</label>
        <input
          id="sheet-stage"
          type="text"
          placeholder="Main Stage"
          maxLength={50}
          list="dl-sheet-stages"
          {...stage.inputProps}
        />
        <datalist id="dl-sheet-stages">
          {stageNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
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

      {/* Takes the slack so the actions stay right-aligned at any width. */}
      <div className={styles.searchBox}>
        <input
          ref={search.ref}
          type="text"
          placeholder="Find…"
          aria-label="Find in sheet"
          // Tells the shell's Cmd+Z handler to leave this field's native
          // text undo alone rather than undoing the last cell edit.
          data-search="true"
          value={search.query}
          onChange={(e) => search.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') search.onEnter()
            else if (e.key === 'Escape') {
              search.onChange('')
              ;(e.target as HTMLElement).blur()
            }
          }}
        />
        {search.query.trim() && (
          <span className={styles.matchCount}>
            {search.matchCount} match{search.matchCount === 1 ? '' : 'es'}
          </span>
        )}
      </div>

      <div className={styles.buttons}>
        <span className={styles.undoGroup}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={history.undo}
            disabled={!history.canUndo}
            title="Undo (Ctrl/Cmd+Z)"
            aria-label="Undo"
          >
            ↶
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={history.redo}
            disabled={!history.canRedo}
            title="Redo (Ctrl/Cmd+Shift+Z)"
            aria-label="Redo"
          >
            ↷
          </button>
        </span>
        <button type="button" onClick={onOpenSubBoxes} title="Define the sub-boxes on stage">
          Boxes
        </button>
        <button
          type="button"
          onClick={onOpenStagePatch}
          title="What each sub-box tail carries, derived from the grid"
        >
          Stage Patch
        </button>
        <button type="button" onClick={onOpenLineup}>
          Lineup
        </button>
        <button type="button" onClick={onOpenVersions}>
          Versions
        </button>
        <button type="button" onClick={onShare} title="Share this sheet into a chat channel">
          Share
        </button>
        <button
          type="button"
          className={styles.export}
          onClick={handleExport}
          title="Export this sheet as CSV"
        >
          Export
        </button>
      </div>
    </div>
  )
}
