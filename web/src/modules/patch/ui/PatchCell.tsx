import { memo } from 'react'
import type * as Y from 'yjs'
import { patchSubBoxDisplay, setPatchField, setPatchSubBox } from '../model/sheetDoc'
import { emptyPatchEntry, type PatchEntry, type PatchField, type SubBox } from '../model/types'
import { syncManager } from '../../_shared/docs/sync'
import { sheetRoom } from '../store/docManager'
import { useDraft } from '../../_shared/ui/useDraft'
import styles from './PatchGrid.module.scss'

function PatchCell({
  doc,
  sheetId,
  artistId,
  channelId,
  field,
  entry,
  subBoxes,
  datalistId,
  label,
  remoteEditor,
  gridPos,
  onNavigate,
  onPasteRange,
  valueAbove,
  isMatch,
}: {
  doc: Y.Doc
  sheetId: string
  artistId: string
  channelId: string
  field: PatchField
  entry: PatchEntry | undefined
  subBoxes: SubBox[]
  datalistId?: string
  label: string
  remoteEditor?: { name: string; color: string }
  /** "row:col" position used for keyboard navigation between cells. */
  gridPos: string
  onNavigate: (gridPos: string, rowDelta: number, colDelta?: number) => void
  /** Multi-cell clipboard text (contains tab/newline) pasted while focused here. */
  onPasteRange: (gridPos: string, text: string) => void
  /** Display value of the same field one channel up — Ctrl/Cmd+D fills it in. */
  valueAbove?: string
  isMatch?: boolean
}) {
  const resolved = entry ?? emptyPatchEntry()
  const displayValue = field === 'subBox' ? patchSubBoxDisplay(resolved, subBoxes) : resolved[field]

  const commitValue = (next: string) => {
    if (field === 'subBox') {
      setPatchSubBox(doc, artistId, channelId, next.trim())
    } else {
      setPatchField(doc, artistId, channelId, field, next)
    }
  }

  const draft = useDraft(displayValue, commitValue)

  const cellId = `${artistId}:${channelId}:${field}`
  const { onBlur, onKeyDown, ...inputProps } = draft.inputProps

  const stripeColor =
    field === 'subBox' && resolved.subBoxId
      ? subBoxes.find((sb) => sb.id === resolved.subBoxId)?.color
      : undefined

  const style: React.CSSProperties = {}
  if (stripeColor) style.borderLeft = `6px solid ${stripeColor}`
  if (remoteEditor) style.boxShadow = `inset 0 0 0 2px ${remoteEditor.color}`

  return (
    <td className={styles.cell}>
      <input
        type="text"
        className={`${styles.cellInput} ${isMatch ? styles.matchCell : ''}`}
        style={Object.keys(style).length > 0 ? style : undefined}
        aria-label={label}
        list={datalistId}
        title={remoteEditor ? `${remoteEditor.name} is editing this cell` : undefined}
        onFocus={() => {
          syncManager.setEditing(sheetRoom(sheetId), cellId)
        }}
        onBlur={() => {
          onBlur()
          syncManager.setEditing(sheetRoom(sheetId), null)
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text/plain')
          if (text.includes('\t') || text.includes('\n')) {
            e.preventDefault()
            draft.reset()
            onPasteRange(gridPos, text)
          }
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
            // Sheets muscle memory: fill down from the cell above.
            e.preventDefault()
            if (valueAbove !== undefined) {
              draft.reset()
              commitValue(valueAbove)
            }
            return
          }
          // Sheets-style arrows: up/down always move (the focus change commits
          // any draft); left/right move from the text boundary or when the
          // whole value is selected (as after arrowing in), so the caret still
          // works for editing within a cell.
          if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
            const input = e.currentTarget
            const len = input.value.length
            const selStart = input.selectionStart ?? 0
            const selEnd = input.selectionEnd ?? 0
            const fullySelected = len > 0 && selStart === 0 && selEnd === len
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              onNavigate(gridPos, e.key === 'ArrowDown' ? 1 : -1)
              return
            }
            if (e.key === 'ArrowLeft' && (fullySelected || (selStart === 0 && selEnd === 0))) {
              e.preventDefault()
              onNavigate(gridPos, 0, -1)
              return
            }
            if (e.key === 'ArrowRight' && (fullySelected || (selStart === len && selEnd === len))) {
              e.preventDefault()
              onNavigate(gridPos, 0, 1)
              return
            }
          }
          onKeyDown(e) // Enter commits via blur; Escape reverts
          if (e.key === 'Enter') onNavigate(gridPos, e.shiftKey ? -1 : 1)
        }}
        data-grid-pos={gridPos}
        data-cell={cellId}
        {...inputProps}
      />
    </td>
  )
}

/**
 * The grid renders channels × artists × fields of these — a festival master
 * patch is easily ~2,000 — and every Yjs update rebuilds the snapshot from
 * scratch, so every object prop arrives as a fresh reference. Without a
 * value-comparing memo, one remote peer committing one cell re-rendered the
 * entire grid on every phone watching the sheet; during a two-desk
 * changeover that is a full-grid reconcile per edit. Compare by value so
 * only the cells whose data actually changed re-render.
 */
const entryEqual = (a: PatchEntry | undefined, b: PatchEntry | undefined): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.subBoxId === b.subBoxId &&
    a.subBoxText === b.subBoxText &&
    a.subBoxTail === b.subBoxTail &&
    a.input === b.input &&
    a.description === b.description &&
    a.micDi === b.micDi &&
    a.stand === b.stand)

const subBoxesEqual = (a: SubBox[], b: SubBox[]): boolean =>
  a === b ||
  (a.length === b.length &&
    a.every((box, i) => {
      const other = b[i]
      return (
        box.id === other.id &&
        box.name === other.name &&
        box.inputs === other.inputs &&
        box.color === other.color &&
        box.stagePosition === other.stagePosition
      )
    }))

type CellProps = Parameters<typeof PatchCell>[0]

const cellPropsEqual = (prev: CellProps, next: CellProps): boolean =>
  prev.doc === next.doc &&
  prev.sheetId === next.sheetId &&
  prev.artistId === next.artistId &&
  prev.channelId === next.channelId &&
  prev.field === next.field &&
  entryEqual(prev.entry, next.entry) &&
  subBoxesEqual(prev.subBoxes, next.subBoxes) &&
  prev.datalistId === next.datalistId &&
  prev.label === next.label &&
  (prev.remoteEditor === next.remoteEditor ||
    (!!prev.remoteEditor &&
      !!next.remoteEditor &&
      prev.remoteEditor.name === next.remoteEditor.name &&
      prev.remoteEditor.color === next.remoteEditor.color)) &&
  prev.gridPos === next.gridPos &&
  prev.onNavigate === next.onNavigate &&
  prev.onPasteRange === next.onPasteRange &&
  prev.valueAbove === next.valueAbove &&
  prev.isMatch === next.isMatch

export default memo(PatchCell, cellPropsEqual)
