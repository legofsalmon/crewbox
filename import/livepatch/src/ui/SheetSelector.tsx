import { useRef, useState } from 'react'
import { createSheet, createSheetFromImport, deleteSheet } from '../store/docManager'
import { useSheetIndex } from '../store/hooks'
import { isoToDisplay } from '../model/date'
import { parseCsv } from '../model/csv'
import { sheetFromCsv } from '../model/importCsv'
import { useToasts } from './toastContext'
import SyncSettingsDialog from './SyncSettingsDialog'
import styles from './SheetSelector.module.scss'

const formatLastEdited = (iso: string): string | null => {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return null
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'Edited just now'
  if (mins < 60) return `Edited ${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `Edited ${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `Edited ${days} d ago`
  return `Edited ${new Date(iso).toLocaleDateString()}`
}

export default function SheetSelector({ onOpen }: { onOpen: (sheetId: string) => void }) {
  const { entries, loaded } = useSheetIndex()
  const { addToast } = useToasts()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [showSyncSettings, setShowSyncSettings] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const rows = parseCsv(await file.text())
      const { data, skippedColumns } = sheetFromCsv(rows)
      if (data.channels.length === 0) {
        addToast('Import failed', 'No rows found in that CSV', 'error')
        return
      }
      const title = file.name.replace(/\.csv$/i, '').trim() || 'Imported Sheet'
      const { sheetId } = createSheetFromImport(title, data)
      const summary = [`${data.channels.length} channels, ${data.artists.length} artist(s)`]
      if (skippedColumns.length > 0) {
        summary.push(`skipped columns: ${skippedColumns.join(', ')}`)
      }
      addToast('Imported', summary.join(' · '), skippedColumns.length > 0 ? 'warning' : 'success')
      onOpen(sheetId)
    } catch (error) {
      addToast('Import failed', error instanceof Error ? error.message : 'Unreadable file', 'error')
    }
  }

  const handleCreate = () => {
    if (!name.trim()) return
    const { sheetId } = createSheet(name)
    addToast('Created', `"${name.trim()}" is ready`, 'success')
    setName('')
    setCreating(false)
    onOpen(sheetId)
  }

  const handleDelete = async (sheetId: string, title: string) => {
    if (!window.confirm(`Delete "${title}" from this device and the shared index?`)) return
    await deleteSheet(sheetId)
    addToast('Deleted', `"${title}" removed`, 'info')
  }

  return (
    <div className={styles.container}>
      <header className={styles.hero}>
        <h1>Live Patch</h1>
        <p>Patch sheets that work with no internet and sync when you have it</p>
        <button
          type="button"
          className={styles.syncButton}
          onClick={() => setShowSyncSettings(true)}
        >
          ⚙ Sync settings
        </button>
      </header>
      {showSyncSettings && <SyncSettingsDialog onClose={() => setShowSyncSettings(false)} />}

      <div className={styles.actions}>
        {creating ? (
          <form
            className={styles.createForm}
            onSubmit={(e) => {
              e.preventDefault()
              handleCreate()
            }}
          >
            <label className={styles.visuallyHidden} htmlFor="new-sheet-name">
              Sheet name
            </label>
            <input
              id="new-sheet-name"
              type="text"
              placeholder="Sheet name (e.g. Summer Fest — Main Stage)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <button type="submit">Create</button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setCreating(false)
                setName('')
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <button type="button" className={styles.createButton} onClick={() => setCreating(true)}>
              + New Sheet
            </button>
            <button
              type="button"
              className={styles.importButton}
              onClick={() => importRef.current?.click()}
              title="Import a CSV exported from Google Sheets, Excel, or Live Patch"
            >
              ⇪ Import CSV
            </button>
            <input
              ref={importRef}
              type="file"
              accept=".csv,text/csv"
              className={styles.hiddenFile}
              aria-label="Import CSV file"
              onChange={(e) => {
                void handleImportFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </>
        )}
      </div>

      <div className={styles.list}>
        {!loaded && entries.length === 0 ? (
          <p className={styles.empty}>Loading…</p>
        ) : entries.length === 0 ? (
          <div className={styles.empty}>
            <h2>No sheets yet</h2>
            <p>Create your first patch sheet to get started</p>
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.sheetId} className={styles.card}>
              <button
                type="button"
                className={styles.cardOpen}
                onClick={() => onOpen(entry.sheetId)}
              >
                <span className={styles.cardTitle}>{entry.title}</span>
                <span className={styles.cardMeta}>
                  {entry.stage && <span>{entry.stage}</span>}
                  {entry.date && <span>{isoToDisplay(entry.date)}</span>}
                </span>
                {formatLastEdited(entry.lastModified) && (
                  <span className={styles.cardEdited}>{formatLastEdited(entry.lastModified)}</span>
                )}
              </button>
              <button
                type="button"
                className={styles.cardDelete}
                onClick={() => handleDelete(entry.sheetId, entry.title)}
                aria-label={`Delete ${entry.title}`}
                title="Delete sheet"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
