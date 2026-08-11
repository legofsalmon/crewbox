import { useCallback, useEffect, useRef, useState } from 'react'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { createSheet, createSheetFromImport, deleteSheet } from '../store/docManager'
import { useSheetIndex } from '../store/hooks'
import { isoToDisplay } from '../model/date'
import { parseCsv } from '../model/csv'
import { sheetFromCsv } from '../model/importCsv'
import { useToasts } from './toastContext'
import { useFileDrop } from '../../../lib/useFileDrop.ts'
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

export default function SheetSelector({
  onOpen,
  startCreating = false,
}: {
  onOpen: (sheetId: string) => void
  /** True when the sidebar's + brought us here: open the name form at once. */
  startCreating?: boolean
}) {
  const { entries, loaded } = useSheetIndex()
  const { addToast } = useToasts()
  const [creating, setCreating] = useState(startCreating)
  const [name, setName] = useState('')
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (startCreating) setCreating(true)
  }, [startCreating])

  // Dropping a CSV anywhere on this page imports it, which is how someone
  // arrives here: with an export from Sheets or Excel already in a folder.
  const isCsv = useCallback(
    (file: File) => /\.csv$/i.test(file.name) || file.type === 'text/csv',
    []
  )
  const onDropFiles = useCallback(
    (files: File[]) => {
      // One sheet per drop. Importing five at once would leave someone
      // guessing which of five new sheets to open.
      void handleImportFile(files[0])
      if (files.length > 1) {
        addToast('Imported the first file', `${files.length - 1} more ignored`, 'warning')
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addToast]
  )
  const onReject = useCallback(
    (files: File[]) => {
      addToast('Not a CSV', `${files[0].name} isn’t something this can import`, 'error')
    },
    [addToast]
  )
  const drop = useFileDrop(onDropFiles, { accept: isCsv, onReject })

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const rows = parseCsv(await file.text())
      const { data, skippedColumns, warnings } = sheetFromCsv(rows)
      if (data.channels.length === 0) {
        addToast('Import failed', 'No rows found in that CSV', 'error')
        return
      }
      const title = file.name.replace(/\.csv$/i, '').trim() || 'Imported Sheet'
      const { sheetId } = createSheetFromImport(title, data)
      const summary = [`${data.channels.length} channels, ${data.acts.length} act(s)`]
      if (skippedColumns.length > 0) {
        summary.push(`skipped columns: ${skippedColumns.join(', ')}`)
      }
      // A sheet whose changeovers disagree with its own set times still
      // imports — it is the crew's sheet and both numbers are theirs. Saying
      // so at the moment they open it is the whole value.
      summary.push(...(warnings ?? []))
      const off = skippedColumns.length > 0 || (warnings?.length ?? 0) > 0
      addToast('Imported', summary.join(' · '), off ? 'warning' : 'success')
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
    <div className={`${styles.container} ${drop.over ? styles.dropping : ''}`} {...drop.handlers}>
      {drop.over && <div className={styles.dropVeil}>Drop a CSV to import it as a new sheet</div>}
      <header className={styles.hero}>
        <div className={styles.heroTop}>
          <DrawerButton />
          <h1>Patch Sheets</h1>
        </div>
        <p>Input patch per act, sub-boxes and a lineup — shared live with everyone on the box.</p>
      </header>

      {/* Buttons stay put and the form opens below them, the same way a
          lighting plot does it — swapping the actions out for a form made the
          page jump and hid Import while you were naming a sheet. */}
      <div className={styles.actions}>
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
      </div>

      {creating && (
        <form
          className={styles.createForm}
          onSubmit={(e) => {
            e.preventDefault()
            handleCreate()
          }}
        >
          <label htmlFor="new-sheet-name">Sheet name</label>
          <input
            id="new-sheet-name"
            type="text"
            placeholder="Summer Fest — Main Stage"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <div className={styles.formActions}>
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
          </div>
        </form>
      )}

      <div className={styles.list}>
        {!loaded && entries.length === 0 ? (
          <p className={styles.empty}>Loading…</p>
        ) : entries.length === 0 ? (
          <p className={styles.empty}>
            No sheets yet. Create one, or drop a CSV anywhere on this page.
          </p>
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
