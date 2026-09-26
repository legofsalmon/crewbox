import { useCallback, useEffect, useRef, useState } from 'react'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { useFileDrop } from '../../../lib/useFileDrop.ts'
import { useStore } from '../../../store.ts'
import { ago } from '../model/format.ts'
import { parseScreenSetup } from '../model/screenSetup.ts'
import { createScreens, deleteScreens, useScreensIndex } from '../store/screensStore.ts'
import styles from './ScreensSelector.module.scss'

/**
 * Every screen map this crew knows about, and the way a new one arrives: an
 * Advanced Output .xml straight from the Resolume machine. Parsed here, on
 * the device that has the file, and stored as a document — the box never
 * sees the XML and never needs Resolume.
 */
export default function ScreensSelector({
  onOpen,
  startCreating = false,
}: {
  onOpen: (id: string) => void
  /**
   * Arrived from the sidebar's `+` rather than from the "All screen maps…"
   * row, so put the cursor on the thing that button promised. Focus rather
   * than opening the picker outright: a file dialog nobody asked for, off a
   * navigation, is the sort of thing a phone user cannot get out of.
   */
  startCreating?: boolean
}) {
  const me = useStore((s) => s.me)
  const by = me?.name ?? ''
  const { entries, loaded } = useScreensIndex()
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const importFile = useCallback(
    async (file: File | undefined) => {
      if (!file || importing) return
      setImporting(true)
      setError(null)
      try {
        const setup = parseScreenSetup(await file.text(), file.name)
        const title = setup.name || file.name.replace(/\.xml$/i, '')
        const { id } = createScreens(title, setup, file.name, by)
        onOpen(id)
      } catch (err) {
        setError(`Import failed: ${err instanceof Error ? err.message : 'unreadable file'}`)
      } finally {
        setImporting(false)
      }
    },
    [importing, by, onOpen]
  )

  const isXml = useCallback((file: File) => /\.xml$/i.test(file.name), [])
  const onDropFiles = useCallback(
    (files: File[]) => {
      // One map per drop: five new maps at once leaves someone guessing which to open.
      void importFile(files[0])
    },
    [importFile]
  )
  const onReject = useCallback((files: File[]) => {
    setError(`${files[0]?.name ?? 'That file'} isn’t an .xml`)
  }, [])
  const drop = useFileDrop(onDropFiles, { disabled: importing, accept: isXml, onReject })
  const now = Date.now()
  const importButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (startCreating) importButtonRef.current?.focus()
  }, [startCreating])

  return (
    <div className={`${styles.selector} ${drop.over ? styles.dropping : ''}`} {...drop.handlers}>
      {drop.over && (
        <div className={styles.dropVeil}>Drop an Advanced Output .xml to import it</div>
      )}
      <header className={styles.hero}>
        <div className={styles.heroTop}>
          <DrawerButton />
          <h1>Screen maps</h1>
        </div>
        <p className={styles.sub}>
          Resolume Arena Advanced Output presets, shared with everyone on the box: where each slice
          takes its pixels from, and where they land on every screen.
        </p>
      </header>

      <div className={styles.actions}>
        <button
          ref={importButtonRef}
          type="button"
          className={styles.importButton}
          disabled={importing}
          onClick={() => fileRef.current?.click()}
        >
          {importing ? 'Reading…' : '⇪ Import Advanced Output XML'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xml,text/xml,application/xml"
          className={styles.hiddenFile}
          aria-label="Import Advanced Output XML"
          onChange={(e) => {
            void importFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
      <p className={styles.hint}>
        Arena keeps presets in <code>Documents/Resolume Arena/Presets/Advanced Output/</code>;{' '}
        <code>Preferences/AdvancedOutput.xml</code> is whatever is on the outputs right now. Nothing
        is sent to Resolume, and the file is read on this device.
      </p>

      {error && <p className={styles.importError}>{error}</p>}

      {!loaded && entries.length === 0 && <p className={styles.empty}>Loading screen maps…</p>}
      {loaded && entries.length === 0 && (
        <p className={styles.empty}>
          No screen maps yet. Import a preset, or drop one anywhere on this page.
        </p>
      )}

      <ul className={styles.list}>
        {entries.map((entry) => (
          <li key={entry.id} className={styles.item}>
            <button type="button" className={styles.open} onClick={() => onOpen(entry.id)}>
              <span className={styles.itemTitle}>{entry.title}</span>
              <span className={styles.itemMeta}>
                {[
                  entry.comp,
                  entry.screens ? `${entry.screens} screen${entry.screens === '1' ? '' : 's'}` : '',
                  entry.lastModified ? `updated ${ago(Date.parse(entry.lastModified), now)}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
            <button
              type="button"
              className={styles.delete}
              aria-label={`Delete ${entry.title}`}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete “${entry.title}” for everyone? An admin can restore it for 7 days.`
                  )
                ) {
                  void deleteScreens(entry.id)
                }
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
