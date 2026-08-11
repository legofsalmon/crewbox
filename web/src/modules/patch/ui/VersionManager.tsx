import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import {
  deleteVersion,
  listVersions,
  restoreVersion,
  saveVersion,
  versionSnapshot,
  type SheetVersion,
} from '../model/versions'
import { useToasts } from './toastContext'
import styles from './Manager.module.scss'

const formatSavedAt = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function VersionRow({
  doc,
  version,
  onRestored,
}: {
  doc: Y.Doc
  version: SheetVersion
  onRestored: () => void
}) {
  const summary = (() => {
    const snap = versionSnapshot(version)
    // Counted from what the version actually holds rather than from a stored
    // list: the acts themselves belong to the event's running order, and a
    // version is a version of this sheet alone.
    const acts = new Set(Object.keys(snap.patches).map((key) => key.slice(0, key.indexOf(':'))))
    for (const actId of Object.keys(snap.extras)) acts.add(actId)
    return `${snap.channels.length} channels · ${acts.size} act${acts.size === 1 ? '' : 's'}`
  })()

  const handleRestore = () => {
    if (
      !window.confirm(
        `Restore "${version.name}"? The sheet's current content will be replaced — you can undo straight after.`
      )
    ) {
      return
    }
    restoreVersion(doc, version.id)
    onRestored()
  }

  const handleDelete = () => {
    if (!window.confirm(`Delete saved version "${version.name}"? This cannot be undone.`)) return
    deleteVersion(doc, version.id)
  }

  return (
    <div className={styles.item}>
      <div className={styles.itemHeader}>
        <div className={styles.versionInfo}>
          <span className={styles.versionName}>{version.name}</span>
          <span className={styles.versionMeta}>
            {formatSavedAt(version.createdAt)} · {summary}
          </span>
        </div>
        <button type="button" className={styles.addButton} onClick={handleRestore}>
          Restore
        </button>
        <button
          type="button"
          className={styles.removeButton}
          onClick={handleDelete}
          aria-label={`Delete version ${version.name}`}
          title="Delete this saved version"
        >
          ×
        </button>
      </div>
    </div>
  )
}

export default function VersionManager({
  doc,
  onUndo,
  onClose,
}: {
  doc: Y.Doc
  /** The sheet's undo — a restore must be reversible by a visible button,
   *  because the confirm's old advice (Ctrl/Cmd+Z) doesn't exist on the
   *  phones most of the crew are holding. */
  onUndo: () => void
  onClose: () => void
}) {
  const { addToast } = useToasts()
  const [name, setName] = useState('')
  const [restored, setRestored] = useState<string | null>(null)
  const versions = listVersions(doc)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSave = () => {
    const saved = saveVersion(doc, name)
    setName('')
    addToast('Version saved', `"${saved.name}" can be restored any time`, 'success')
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.popover}
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-manager-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="version-manager-title">Versions</h2>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className={styles.content}>
          <p className={styles.hint}>
            Save a named copy of the sheet as it is right now — before doors, after soundcheck — and
            restore it later. Versions sync to other devices; restoring is one undo step.
          </p>
          <div className={`${styles.controls} ${styles.saveRow}`}>
            <input
              type="text"
              className={styles.wideInput}
              placeholder="e.g. After soundcheck"
              aria-label="Version name"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave()
              }}
            />
            <button type="button" className={styles.addButton} onClick={handleSave}>
              Save current version
            </button>
          </div>
          {restored && (
            <div className={styles.restoredBar}>
              <span>Restored “{restored}” — the sheet now matches that snapshot.</span>
              <button
                type="button"
                className={styles.addButton}
                onClick={() => {
                  onUndo()
                  setRestored(null)
                  addToast('Restore undone', 'The sheet is back as it was', 'info')
                }}
              >
                Undo restore
              </button>
            </div>
          )}
          {versions.length === 0 ? (
            <div className={styles.empty}>
              <p>No versions saved yet.</p>
              <p>Saved versions appear here, newest first.</p>
            </div>
          ) : (
            versions.map((version) => (
              <VersionRow
                key={version.id}
                doc={doc}
                version={version}
                onRestored={() => setRestored(version.name)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
