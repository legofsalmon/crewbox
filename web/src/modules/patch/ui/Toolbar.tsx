import type { RefObject } from 'react'
import type * as Y from 'yjs'
import { setMetaField } from '../model/sheetDoc'
import { displayToIso, isoToDisplay } from '../model/date'
import type { SheetSnapshot } from '../model/types'
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
  onOpenSubBoxes: () => void
  onOpenStagePatch: () => void
  onOpenLineup: () => void
  onOpenVersions: () => void
  onShare: () => void
  history: History
  search: Search
}) {
  const { addToast } = useToasts()

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
