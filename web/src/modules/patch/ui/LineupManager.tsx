import { useCallback, useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { useFileDrop } from '../../../lib/useFileDrop.ts'
import {
  addArtist,
  addArtistFile,
  removeArtist,
  removeArtistFile,
  updateArtist,
} from '../model/sheetDoc'
import type { Artist, SheetSnapshot } from '../model/types'
import {
  attachmentUrl,
  canUseAttachments,
  MAX_ATTACHMENT_BYTES,
  uploadAttachment,
} from '../store/files'
import { formatBytes } from '../../../lib/files.ts'
import { patchEntryHasContent } from '../model/types'
import { useDraft } from '../../_shared/ui/useDraft'
import { useToasts } from './toastContext'
import styles from './Manager.module.scss'

const ACCEPTED_TYPE = (type: string) => type.startsWith('image/') || type === 'application/pdf'

function ArtistFiles({ doc, artist }: { doc: Y.Doc; artist: Artist }) {
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
        addArtistFile(doc, artist.id, meta)
      }
    } catch (error) {
      addToast('Upload failed', error instanceof Error ? error.message : 'Unknown error', 'error')
    } finally {
      setUploading(false)
    }
  }

  // Dropping straight onto an artist's row: a stage plot or rider usually
  // arrives as an email attachment already sitting in a folder.
  const onDropFiles = useCallback(
    (files: File[]) => void handleUpload(files),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  const drop = useFileDrop(onDropFiles, { disabled: !enabled || uploading })

  const handleRemove = (fileId: string) => {
    removeArtistFile(doc, artist.id, fileId)
    // The blob stays on the box (content-addressed, shared); only the
    // sheet's reference goes away.
  }

  return (
    <div className={`${styles.notes} ${drop.over ? styles.dropping : ''}`} {...drop.handlers}>
      <label htmlFor={`artist-files-${artist.id}`}>
        Files (images &amp; PDFs){drop.over ? ' — drop to attach' : ':'}
      </label>
      <input
        id={`artist-files-${artist.id}`}
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
      {artist.files.length > 0 && (
        <ul className={styles.fileList}>
          {artist.files.map((file) => (
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

function ArtistRow({
  doc,
  artist,
  removable,
  hasContent,
}: {
  doc: Y.Doc
  artist: Artist
  removable: boolean
  hasContent: boolean
}) {
  const name = useDraft(artist.name, (next) =>
    updateArtist(doc, artist.id, { name: next.trim() || artist.name })
  )
  const notes = useDraft(artist.notes, (next) => updateArtist(doc, artist.id, { notes: next }), {
    multiline: true,
  })

  const handleRemove = () => {
    if (
      hasContent &&
      !window.confirm(`Remove "${artist.name}"? Their patch data and files will be deleted.`)
    ) {
      return
    }
    removeArtist(doc, artist.id)
  }

  return (
    <div className={styles.item}>
      <div className={styles.itemHeader}>
        <input
          className={styles.nameInput}
          type="text"
          placeholder="Artist name"
          aria-label="Artist name"
          {...name.inputProps}
        />
        <button
          type="button"
          className={styles.removeButton}
          onClick={handleRemove}
          disabled={!removable}
          aria-label={`Remove ${artist.name}`}
          title={removable ? 'Remove artist' : 'At least one artist is required'}
        >
          ×
        </button>
      </div>
      <div className={styles.fieldRow}>
        <div className={styles.fieldGroup}>
          <label htmlFor={`artist-start-${artist.id}`}>Start:</label>
          <input
            id={`artist-start-${artist.id}`}
            type="time"
            value={artist.startTime}
            onChange={(e) => updateArtist(doc, artist.id, { startTime: e.target.value })}
          />
        </div>
        <div className={styles.fieldGroup}>
          <label htmlFor={`artist-end-${artist.id}`}>End:</label>
          <input
            id={`artist-end-${artist.id}`}
            type="time"
            value={artist.endTime}
            onChange={(e) => updateArtist(doc, artist.id, { endTime: e.target.value })}
          />
        </div>
      </div>
      <div className={styles.notes}>
        <label htmlFor={`artist-notes-${artist.id}`}>Notes:</label>
        <textarea
          id={`artist-notes-${artist.id}`}
          rows={2}
          placeholder="Performance notes, requirements, etc."
          {...notes.inputProps}
        />
      </div>
      <ArtistFiles doc={doc} artist={artist} />
    </div>
  )
}

export default function LineupManager({
  doc,
  snapshot,
  onClose,
}: {
  doc: Y.Doc
  snapshot: SheetSnapshot
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
          <h2 id="lineup-manager-title">Lineup Manager</h2>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className={styles.content}>
          <div className={styles.controls}>
            <button type="button" className={styles.addButton} onClick={() => addArtist(doc)}>
              + Add Artist
            </button>
          </div>
          {snapshot.artists.map((artist) => (
            <ArtistRow
              key={artist.id}
              doc={doc}
              artist={artist}
              removable={snapshot.artists.length > 1}
              hasContent={
                artist.files.length > 0 ||
                Object.entries(snapshot.patches).some(
                  ([key, entry]) => key.startsWith(`${artist.id}:`) && patchEntryHasContent(entry)
                )
              }
            />
          ))}
        </div>
      </div>
    </div>
  )
}
