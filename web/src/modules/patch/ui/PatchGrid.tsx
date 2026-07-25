import { Fragment, useCallback, useRef } from 'react'
import type * as Y from 'yjs'
import {
  addChannel,
  copyPatchesFromArtist,
  pasteGrid,
  patchSubBoxDisplay,
  removeChannel,
  renameChannel,
  subBoxDisplayName,
  type PasteColumn,
} from '../model/sheetDoc'
import { parseTsv } from '../model/csv'
import {
  PATCH_FIELDS,
  PATCH_FIELD_LABELS,
  patchEntryHasContent,
  patchKey,
  type Channel,
  type SheetSnapshot,
} from '../model/types'
import { FIELD_SUGGESTIONS, SUB_BOX_FALLBACK_SUGGESTIONS } from '../model/constants'
import { useRemotePeers } from '../store/useSync'
import PatchCell from './PatchCell'
import { useDraft } from './useDraft'
import { useToasts } from './toastContext'
import styles from './PatchGrid.module.scss'

const DATALIST_IDS: Record<string, string> = {
  subBox: 'dl-sub-box',
  input: 'dl-input',
  description: 'dl-description',
  micDi: 'dl-mic-di',
  stand: 'dl-stand',
}

function ChannelHeader({
  doc,
  channel,
  removable,
  hasContent,
  isMatch,
}: {
  doc: Y.Doc
  channel: Channel
  removable: boolean
  hasContent: boolean
  isMatch?: boolean
}) {
  const draft = useDraft(channel.label, (next) => renameChannel(doc, channel.id, next.trim()))

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
          {...draft.inputProps}
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

export default function PatchGrid({
  doc,
  docName,
  snapshot,
  matchedCells,
  matchedChannels,
}: {
  doc: Y.Doc
  docName: string
  snapshot: SheetSnapshot
  /** Cell ids (`artistId:channelId:field`) highlighted by the find box. */
  matchedCells?: Set<string>
  /** Channel ids whose label matches the find query. */
  matchedChannels?: Set<string>
}) {
  const { channels, artists, subBoxes, patches } = snapshot
  const remotePeers = useRemotePeers(docName)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const { addToast } = useToasts()

  // A rectangular block pasted from Google Sheets (TSV on the clipboard):
  // fill right/down from the focused cell, appending channels as needed.
  const handlePasteRange = useCallback(
    (gridPos: string, text: string) => {
      const rows = parseTsv(text)
      if (rows.length === 0) return
      const [rowIndex, colIndex] = gridPos.split(':').map(Number)
      const startChannel = channels[rowIndex]
      if (!startChannel) return
      const allColumns: PasteColumn[] = artists.flatMap((artist) =>
        PATCH_FIELDS.map((field) => ({ artistId: artist.id, field }))
      )
      const columns = allColumns.slice(colIndex)
      const widest = Math.max(...rows.map((row) => row.length))
      const { addedChannels, writtenCells } = pasteGrid(doc, startChannel.id, columns, rows)
      const parts = [`Pasted ${writtenCells} cell${writtenCells === 1 ? '' : 's'}`]
      if (addedChannels > 0) parts.push(`added ${addedChannels} channel(s)`)
      if (widest > columns.length) parts.push(`${widest - columns.length} column(s) didn't fit`)
      addToast('Paste', parts.join(' · '), widest > columns.length ? 'warning' : 'success')
    },
    [doc, channels, artists, addToast]
  )

  const remoteEditors: Record<string, { name: string; color: string }> = {}
  for (const peer of remotePeers) {
    if (peer.editingCell) remoteEditors[peer.editingCell] = { name: peer.name, color: peer.color }
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

      <table className={styles.table}>
        <thead>
          <tr>
            <td className={`${styles.cornerCell} ${styles.stickyCorner}`} aria-hidden="true" />
            {artists.map((artist, index) => (
              <th key={artist.id} colSpan={PATCH_FIELDS.length} className={styles.artistHeader}>
                <div className={styles.artistHeaderInner}>
                  <span className={styles.artistName}>{artist.name}</span>
                  <span className={styles.artistTime}>
                    {artist.startTime}–{artist.endTime}
                  </span>
                  {index > 0 && (
                    <button
                      type="button"
                      className={styles.copyButton}
                      onClick={() => copyPatchesFromArtist(doc, artists[index - 1].id, artist.id)}
                      title={`Copy patch from ${artists[index - 1].name}`}
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
              Ch
            </th>
            {artists.map((artist) => (
              <Fragment key={artist.id}>
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
                hasContent={artists.some((artist) =>
                  patchEntryHasContent(patches[patchKey(artist.id, channel.id)])
                )}
                isMatch={matchedChannels?.has(channel.id)}
              />
              {artists.map((artist, artistIndex) => (
                <Fragment key={artist.id}>
                  {PATCH_FIELDS.map((field, fieldIndex) => {
                    const entryAbove =
                      rowIndex > 0
                        ? patches[patchKey(artist.id, channels[rowIndex - 1].id)]
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
                        docName={docName}
                        artistId={artist.id}
                        channelId={channel.id}
                        field={field}
                        entry={patches[patchKey(artist.id, channel.id)]}
                        subBoxes={subBoxes}
                        datalistId={DATALIST_IDS[field]}
                        label={`${artist.name}, channel ${channel.label}, ${PATCH_FIELD_LABELS[field]}`}
                        remoteEditor={remoteEditors[`${artist.id}:${channel.id}:${field}`]}
                        gridPos={`${rowIndex}:${artistIndex * PATCH_FIELDS.length + fieldIndex}`}
                        onNavigate={navigate}
                        onPasteRange={handlePasteRange}
                        valueAbove={valueAbove}
                        isMatch={matchedCells?.has(`${artist.id}:${channel.id}:${field}`)}
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
      </div>
    </div>
  )
}
