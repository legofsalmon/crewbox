import { Fragment, useCallback, useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { useFileDrop } from '../../../lib/useFileDrop.ts'
import { addAct, removeAct, updateAct } from '../../../shell/timetable/model.ts'
import { timetable } from '../../../shell/timetable/store.ts'
import { addActFile, clearActFromSheet, removeActFile, setActExtra } from '../model/sheetDoc'
import { formatChangeover, gapBetween } from '../model/changeover'
import { patchEntryHasContent, type SheetAct, type SheetSnapshot } from '../model/types'
import {
  attachmentUrl,
  canUseAttachments,
  MAX_ATTACHMENT_BYTES,
  uploadAttachment,
} from '../store/files'
import { formatBytes } from '../../../lib/files.ts'
import { useDraft } from '../../_shared/ui/useDraft'
import { useToasts } from './toastContext'
import styles from './Manager.module.scss'

/**
 * The lineup, over two documents.
 *
 * Who an act is and when they are on belongs to the event's running order —
 * the same answer for audio, lighting, the stage manager and the countdown on
 * every phone — so the name, the times and the changeover here write straight
 * to it. The spec, the notes and the riders are this sheet's own business and
 * stay in the sheet.
 *
 * Nothing says which is which, because from a crew's point of view there is
 * one lineup and this is it. The difference only shows in the good way: a set
 * time moved here has moved everywhere by the time the finger leaves the key.
 */

const ACCEPTED_TYPE = (type: string) => type.startsWith('image/') || type === 'application/pdf'

function ActFiles({ doc, act }: { doc: Y.Doc; act: SheetAct }) {
  const { addToast } = useToasts()
  const [uploading, setUploading] = useState(false)
  const enabled = canUseAttachments()

  const handleUpload = async (incoming: File[] | null) => {
    if (!incoming || incoming.length === 0) return
    setUploading(true)
    try {
      for (const file of incoming) {
        if (!ACCEPTED_TYPE(file.type)) {
          addToast('Skipped file', `"${file.name}" is not an image or PDF`, 'warning')
          continue
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          addToast(
            'File too large',
            `"${file.name}" exceeds ${formatBytes(MAX_ATTACHMENT_BYTES)}`,
            'warning'
          )
          continue
        }
        const meta = await uploadAttachment(file)
        addActFile(doc, act.id, meta)
      }
    } catch (error) {
      addToast('Upload failed', error instanceof Error ? error.message : 'Unknown error', 'error')
    } finally {
      setUploading(false)
    }
  }

  // Dropping straight onto an act's row: a stage plot or rider usually
  // arrives as an email attachment already sitting in a folder.
  const onDropFiles = useCallback(
    (files: File[]) => void handleUpload(files),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  const drop = useFileDrop(onDropFiles, { disabled: !enabled || uploading })

  const handleRemove = (fileId: string) => {
    removeActFile(doc, act.id, fileId)
    // The blob stays on the box (content-addressed, shared); only the
    // sheet's reference goes away.
  }

  return (
    <div className={`${styles.notes} ${drop.over ? styles.dropping : ''}`} {...drop.handlers}>
      <label htmlFor={`act-files-${act.id}`}>
        Files (images &amp; PDFs){drop.over ? ' — drop to attach' : ':'}
      </label>
      <input
        id={`act-files-${act.id}`}
        type="file"
        accept="image/*,.pdf"
        multiple
        disabled={!enabled || uploading}
        onChange={(e) => {
          void handleUpload(e.target.files ? Array.from(e.target.files) : null)
          e.target.value = ''
        }}
      />
      {!enabled && (
        <p className={styles.fileHint}>
          Attachments are stored on the crew server — files need a connection.
        </p>
      )}
      {act.files.length > 0 && (
        <ul className={styles.fileList}>
          {act.files.map((file) => (
            <li key={file.id} className={styles.fileItem}>
              {enabled ? (
                <a href={attachmentUrl(file)} target="_blank" rel="noreferrer">
                  {file.name}
                </a>
              ) : (
                <span>{file.name}</span>
              )}
              <span className={styles.fileSize}>{formatBytes(file.size)}</span>
              <button
                type="button"
                className={styles.removeFileButton}
                onClick={() => handleRemove(file.id)}
                aria-label={`Remove ${file.name}`}
                title="Remove file"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ActRow({ doc, act, hasContent }: { doc: Y.Doc; act: SheetAct; hasContent: boolean }) {
  const timetableDoc = timetable().doc
  const name = useDraft(act.name, (next) =>
    updateAct(timetableDoc, act.id, { name: next.trim() || act.name })
  )
  const notes = useDraft(act.notes, (next) => setActExtra(doc, act.id, 'notes', next), {
    multiline: true,
  })
  // Two boxes, not one, because a paper sheet has two and they hold different
  // things: the spec is what the act brings and needs, and gets read before
  // the day; the notes are whatever came up, and get read on it.
  const spec = useDraft(act.spec, (next) => setActExtra(doc, act.id, 'spec', next), {
    multiline: true,
  })

  const handleRemove = () => {
    // Taking an act off here takes it off the running order, which is a
    // bigger thing than clearing a column used to be — the countdowns and
    // every other department lose it too. Say so plainly.
    const detail = hasContent
      ? ' Its patch data and files on this sheet go with it.'
      : ' It will disappear from the running order and every other module.'
    if (!window.confirm(`Remove "${act.name || 'this act'}" from the event?${detail}`)) return
    clearActFromSheet(doc, act.id)
    removeAct(timetableDoc, act.id)
  }

  return (
    <div className={styles.item}>
      <div className={styles.itemHeader}>
        <input
          className={styles.nameInput}
          type="text"
          placeholder="Act name"
          aria-label="Act name"
          {...name.inputProps}
        />
        <button
          type="button"
          className={styles.removeButton}
          onClick={handleRemove}
          aria-label={`Remove ${act.name}`}
          title="Remove from the running order"
        >
          ×
        </button>
      </div>
      <div className={styles.fieldRow}>
        <div className={styles.fieldGroup}>
          <label htmlFor={`act-start-${act.id}`}>Start:</label>
          <input
            id={`act-start-${act.id}`}
            type="time"
            value={act.start}
            onChange={(e) => updateAct(timetableDoc, act.id, { start: e.target.value })}
          />
        </div>
        <div className={styles.fieldGroup}>
          <label htmlFor={`act-end-${act.id}`}>End:</label>
          <input
            id={`act-end-${act.id}`}
            type="time"
            value={act.end}
            onChange={(e) => updateAct(timetableDoc, act.id, { end: e.target.value })}
          />
        </div>
      </div>
      <div className={styles.notes}>
        <label htmlFor={`act-spec-${act.id}`}>Spec:</label>
        <textarea
          id={`act-spec-${act.id}`}
          rows={2}
          placeholder="Backline, band size, what they bring…"
          {...spec.inputProps}
        />
      </div>
      <div className={styles.notes}>
        <label htmlFor={`act-notes-${act.id}`}>Additional info:</label>
        <textarea
          id={`act-notes-${act.id}`}
          rows={2}
          placeholder="Anything that came up on the day"
          {...notes.inputProps}
        />
      </div>
      <ActFiles doc={doc} act={act} />
    </div>
  )
}

/**
 * The gap between two acts, editable, with the running order to check it.
 *
 * A festival day is a sequence of changeovers with sets in between, and this
 * is the number people actually plan around. It is stored on the act it
 * precedes; it is drawn between the two so nobody has to know that.
 *
 * When the set times imply a different gap, both are shown. Which is right
 * depends on whether the times moved or the changeover did, and only the
 * person holding the running order knows — so this points at the
 * disagreement instead of resolving it.
 */
function Changeover({ act, previous }: { act: SheetAct; previous: SheetAct }) {
  const timetableDoc = timetable().doc
  const derived = gapBetween(previous.end, act.start)
  const stated = act.changeover
  const disagrees = stated > 0 && derived !== null && derived !== stated

  return (
    <div className={styles.changeover}>
      <span className={styles.changeoverRule} aria-hidden="true" />
      <label htmlFor={`act-changeover-${act.id}`}>Changeover:</label>
      <input
        id={`act-changeover-${act.id}`}
        type="number"
        min={0}
        step={5}
        className={styles.changeoverInput}
        value={stated > 0 ? String(stated) : ''}
        placeholder={derived === null ? '—' : String(derived)}
        onChange={(e) => {
          const value = Number(e.target.value)
          updateAct(timetableDoc, act.id, {
            changeover: Number.isFinite(value) && value > 0 ? Math.round(value) : 0,
          })
        }}
      />
      <span>min</span>
      {/* "1 hr 30" is easier to hold in your head than "90". Below an hour
          the minutes already read fine and repeating them would just say
          "45 min" twice. */}
      {stated >= 60 && <span className={styles.changeoverPretty}>{formatChangeover(stated)}</span>}
      {disagrees && (
        <span className={styles.changeoverClash} role="status">
          ⚠ the set times leave {formatChangeover(derived)}
        </span>
      )}
      <span className={styles.changeoverRule} aria-hidden="true" />
    </div>
  )
}

export default function LineupManager({
  doc,
  snapshot,
  acts,
  onClose,
}: {
  doc: Y.Doc
  snapshot: SheetSnapshot
  acts: SheetAct[]
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // A new act inherits this sheet's stage and day, which is what makes it
  // this sheet's act: that pair is how a sheet picks its columns out of the
  // running order.
  const handleAdd = () =>
    addAct(timetable().doc, { stage: snapshot.meta.stage, date: snapshot.meta.date })

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.popover}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lineup-manager-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="lineup-manager-title">Lineup</h2>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className={styles.content}>
          <div className={styles.controls}>
            <button type="button" className={styles.addButton} onClick={handleAdd}>
              + Add Act
            </button>
          </div>
          <p className={styles.lineupHint}>
            Names and times are the event’s running order — edit them here and every department sees
            it. The spec, notes and files belong to this sheet.
          </p>
          {acts.length === 0 && (
            <p className={styles.lineupHint}>
              Nothing on <strong>{snapshot.meta.stage || 'this sheet'}</strong>
              {snapshot.meta.date ? ' that day' : ''} yet.
            </p>
          )}
          {acts.map((act, index) => (
            <Fragment key={act.id}>
              {/* The changeover sits *between* two acts, which is where the
                  sheet draws it and how a crew thinks about it — "we've
                  forty-five minutes after this one". Drawn as a divider
                  rather than as a field on either act, so there is never a
                  question about which of the two it belongs to. */}
              {index > 0 && <Changeover act={act} previous={acts[index - 1]!} />}
              <ActRow
                doc={doc}
                act={act}
                hasContent={
                  act.files.length > 0 ||
                  Object.entries(snapshot.patches).some(
                    ([key, entry]) => key.startsWith(`${act.id}:`) && patchEntryHasContent(entry)
                  )
                }
              />
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}
