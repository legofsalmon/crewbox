import { Fragment, memo, useCallback, useRef } from 'react'
import type * as Y from 'yjs'
import {
  addChannel,
  copyPatchesFromAct,
  pasteGrid,
  patchSubBoxDisplay,
  removeChannel,
  renameChannel,
  setChannelInput,
  subBoxDisplayName,
  type PasteColumn,
} from '../model/sheetDoc'
import { parseTsv } from '../model/csv'
import { channelCellId } from '../model/find'
import {
  PATCH_FIELDS,
  PATCH_FIELD_LABELS,
  patchEntryHasContent,
  patchKey,
  type Channel,
  type SheetAct,
  type SheetSnapshot,
} from '../model/types'
import { FIELD_SUGGESTIONS, SUB_BOX_FALLBACK_SUGGESTIONS } from '../model/constants'
import { useSheetRemotePeers } from '../store/useSync'
import PatchCell from './PatchCell'
import { useDraft } from '../../_shared/ui/useDraft'
import { useToasts } from './toastContext'
import styles from './PatchGrid.module.scss'

const DATALIST_IDS: Record<string, string> = {
  subBox: 'dl-sub-box',
  input: 'dl-input',
  description: 'dl-description',
  micDi: 'dl-mic-di',
  stand: 'dl-stand',
}

function ChannelHeaderRow({
  doc,
  channel,
  removable,
  hasContent,
  isMatch,
  inputMatch,
}: {
  doc: Y.Doc
  channel: Channel
  removable: boolean
  hasContent: boolean
  isMatch?: boolean
  /** The house input matched the find query, not the channel's number. */
  inputMatch?: boolean
}) {
  const draft = useDraft(channel.label, (next) => renameChannel(doc, channel.id, next.trim()))
  const input = useDraft(channel.input, (next) => setChannelInput(doc, channel.id, next.trim()))

  const handleRemove = () => {
    if (
      hasContent &&
      !window.confirm(`Remove channel "${channel.label}"? Its patch data will be deleted.`)
    ) {
      return
    }
    removeChannel(doc, channel.id)
  }

  return (
    <th scope="row" className={styles.channelHeader}>
      <div className={styles.channelHeaderInner}>
        <input
          type="text"
          className={`${styles.channelInput} ${isMatch ? styles.matchCell : ''}`}
          aria-label={`Channel ${channel.label} name`}
          data-cell={channelCellId(channel.id, 'label')}
          {...draft.inputProps}
        />
        {/* The house input: what is on this channel all day, whoever is
            playing. Lives on the channel rather than in every act's
            column, because on a festival stage only the sub-box and the mic
            change between acts. */}
        <input
          type="text"
          className={`${styles.houseInput} ${inputMatch ? styles.matchCell : ''}`}
          placeholder="input"
          aria-label={`Input on channel ${channel.label}`}
          data-cell={channelCellId(channel.id, 'input')}
          {...input.inputProps}
        />
        <span className={styles.channelActions}>
          <button
            type="button"
            onClick={() => addChannel(doc, channel.id)}
            title="Insert channel below"
            aria-label={`Insert channel below ${channel.label}`}
          >
            +
          </button>
          <button
            type="button"
            onClick={handleRemove}
            disabled={!removable}
            title={removable ? 'Remove channel' : 'At least one channel is required'}
            aria-label={`Remove channel ${channel.label}`}
          >
            −
          </button>
        </span>
      </div>
    </th>
  )
}

/**
 * Memoized by value for the same reason as PatchCell: the snapshot rebuilds
 * `channel` as a fresh object on every doc update, so reference equality
 * alone would re-render every row header on every remote edit.
 */
const ChannelHeader = memo(
  ChannelHeaderRow,
  (prev, next) =>
    prev.doc === next.doc &&
    prev.channel.id === next.channel.id &&
    prev.channel.label === next.channel.label &&
    prev.channel.input === next.channel.input &&
    prev.removable === next.removable &&
    prev.hasContent === next.hasContent &&
    prev.isMatch === next.isMatch &&
    prev.inputMatch === next.inputMatch
)

export default function PatchGrid({
  doc,
  sheetId,
  snapshot,
  acts,
  onOpenLineup,
  matchedCells,
  matchedChannels,
  matchedInputs,
}: {
  doc: Y.Doc
  sheetId: string
  snapshot: SheetSnapshot
  /** This stage's acts from the running order, in order. Columns, in short. */
  acts: SheetAct[]
  onOpenLineup: () => void
  /** Cell ids (`actId:channelId:field`) highlighted by the find box. */
  matchedCells?: Set<string>
  /** Channel ids whose label matches the find query. */
  matchedChannels?: Set<string>
  /** Channel ids whose house input matches — the sheet's spine. */
  matchedInputs?: Set<string>
}) {
  const { channels, subBoxes, patches } = snapshot
  // "Nothing typed yet": no patch data at all. A fresh sheet has channels
  // (the numbered rows) but no patches, so this is the honest test.
  const untouched = Object.keys(patches).length === 0
  const remotePeers = useSheetRemotePeers(sheetId)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const { addToast } = useToasts()

  // A rectangular block pasted from Google Sheets (TSV on the clipboard):
  // fill right/down from the focused cell, appending channels as needed.
  //
  // The changing inputs live behind a ref so the callback itself is
  // referentially stable — it is a prop of every memoized PatchCell, and a
  // fresh function here would defeat the memo for the whole grid on every
  // snapshot.
  const pasteContext = useRef({ channels, acts, addToast })
  pasteContext.current = { channels, acts, addToast }
  const handlePasteRange = useCallback(
    (gridPos: string, text: string) => {
      const { channels, acts, addToast } = pasteContext.current
      const rows = parseTsv(text)
      if (rows.length === 0) return
      const [rowIndex, colIndex] = gridPos.split(':').map(Number)
      const startChannel = channels[rowIndex]
      if (!startChannel) return
      const allColumns: PasteColumn[] = acts.flatMap((act) =>
        PATCH_FIELDS.map((field) => ({ actId: act.id, field }))
      )
      const columns = allColumns.slice(colIndex)
      const widest = Math.max(...rows.map((row) => row.length))
      const { addedChannels, writtenCells } = pasteGrid(doc, startChannel.id, columns, rows)
      const parts = [`Pasted ${writtenCells} cell${writtenCells === 1 ? '' : 's'}`]
      if (addedChannels > 0) parts.push(`added ${addedChannels} channel(s)`)
      if (widest > columns.length) parts.push(`${widest - columns.length} column(s) didn't fit`)
      addToast('Paste', parts.join(' · '), widest > columns.length ? 'warning' : 'success')
    },
    [doc]
  )

  const remoteEditors: Record<string, { name: string; color: string }> = {}
  for (const peer of remotePeers) {
    if (peer.editing) remoteEditors[peer.editing] = { name: peer.name, color: peer.color }
  }

  // Enter/Shift+Enter and the arrow keys move between cells, spreadsheet-style.
  // Moves off the grid's edge are no-ops (no matching input to focus).
  const navigate = useCallback((gridPos: string, rowDelta: number, colDelta = 0) => {
    const [row, col] = gridPos.split(':').map(Number)
    const target = wrapperRef.current?.querySelector<HTMLInputElement>(
      `input[data-grid-pos="${row + rowDelta}:${col + colDelta}"]`
    )
    if (target) {
      target.focus()
      target.select()
    }
  }, [])

  const subBoxOptions =
    subBoxes.length > 0 ? subBoxes.map(subBoxDisplayName) : [...SUB_BOX_FALLBACK_SUGGESTIONS]

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      {/* Shared datalists — one instance per field, referenced by every cell */}
      <datalist id={DATALIST_IDS.subBox}>
        {subBoxOptions.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
      {PATCH_FIELDS.filter((f) => f !== 'subBox').map((field) => (
        <datalist key={field} id={DATALIST_IDS[field]}>
          {(FIELD_SUGGESTIONS[field] ?? []).map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ))}

      {acts.length === 0 && (
        // A grid with no columns, and no clue why. The acts are on the
        // event's running order now, so the two ways out are both named: put
        // one there, or point this sheet at a stage that already has some.
        <p className={styles.noActs}>
          Nothing is on <strong>{snapshot.meta.stage || 'this sheet'}</strong> yet. Acts live on the
          running order, so every department works from the same times —{' '}
          <button type="button" className={styles.inlineLink} onClick={onOpenLineup}>
            add one in the lineup
          </button>
          , or set the stage above to one that already has acts.
        </p>
      )}

      <table className={styles.table}>
        <thead>
          <tr>
            <td className={`${styles.cornerCell} ${styles.stickyCorner}`} aria-hidden="true" />
            {acts.map((act, index) => (
              <th key={act.id} colSpan={PATCH_FIELDS.length} className={styles.actHeader}>
                <div className={styles.actHeaderInner}>
                  <span className={styles.actName}>{act.name}</span>
                  {/* Imported sheets often carry no set times, and a bare
                      en-dash on every column is worse than nothing. */}
                  {(act.start || act.end) && (
                    <span className={styles.actTime}>
                      {act.start}–{act.end}
                    </span>
                  )}
                  {index > 0 && (
                    <button
                      type="button"
                      className={styles.copyButton}
                      onClick={() => copyPatchesFromAct(doc, acts[index - 1].id, act.id)}
                      title={`Copy patch from ${acts[index - 1].name}`}
                    >
                      ← Copy
                    </button>
                  )}
                </div>
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col" className={`${styles.fieldHeader} ${styles.stickyCorner}`}>
              Ch · Input
            </th>
            {acts.map((act) => (
              <Fragment key={act.id}>
                {PATCH_FIELDS.map((field) => (
                  <th key={field} scope="col" className={styles.fieldHeader}>
                    {PATCH_FIELD_LABELS[field]}
                  </th>
                ))}
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {channels.map((channel, rowIndex) => (
            <tr key={channel.id}>
              <ChannelHeader
                doc={doc}
                channel={channel}
                removable={channels.length > 1}
                hasContent={acts.some((act) =>
                  patchEntryHasContent(patches[patchKey(act.id, channel.id)])
                )}
                isMatch={matchedChannels?.has(channel.id)}
                inputMatch={matchedInputs?.has(channel.id)}
              />
              {acts.map((act, actIndex) => (
                <Fragment key={act.id}>
                  {PATCH_FIELDS.map((field, fieldIndex) => {
                    const entryAbove =
                      rowIndex > 0
                        ? patches[patchKey(act.id, channels[rowIndex - 1].id)]
                        : undefined
                    const valueAbove =
                      rowIndex > 0
                        ? field === 'subBox'
                          ? entryAbove
                            ? patchSubBoxDisplay(entryAbove, subBoxes)
                            : ''
                          : (entryAbove?.[field] ?? '')
                        : undefined
                    return (
                      <PatchCell
                        key={field}
                        doc={doc}
                        sheetId={sheetId}
                        actId={act.id}
                        channelId={channel.id}
                        field={field}
                        entry={patches[patchKey(act.id, channel.id)]}
                        subBoxes={subBoxes}
                        datalistId={DATALIST_IDS[field]}
                        label={`${act.name}, channel ${channel.label}, ${PATCH_FIELD_LABELS[field]}`}
                        remoteEditor={remoteEditors[`${act.id}:${channel.id}:${field}`]}
                        gridPos={`${rowIndex}:${actIndex * PATCH_FIELDS.length + fieldIndex}`}
                        onNavigate={navigate}
                        onPasteRange={handlePasteRange}
                        valueAbove={valueAbove}
                        isMatch={matchedCells?.has(`${act.id}:${channel.id}:${field}`)}
                      />
                    )
                  })}
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className={styles.gridActions}>
        <button type="button" onClick={() => addChannel(doc)}>
          + Add Channel
        </button>
        {/* A brand-new sheet is ten blank rows and no clue what to do with
            them. Only shown while nothing has been filled in, so it never
            nags anyone working. */}
        {untouched && acts.length > 0 && (
          <p className={styles.startHint}>
            Type straight into the grid, or bring one in from the sheet list with{' '}
            <strong>Import CSV</strong>.
          </p>
        )}
      </div>
    </div>
  )
}
