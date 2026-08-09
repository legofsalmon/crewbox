import { useCallback, useEffect, useRef, useState } from 'react'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { useFileDrop } from '../../../lib/useFileDrop.ts'
import { createPlot, deletePlot } from '../store/docManager'
import { usePlotIndex } from '../store/hooks'
import { importPlotFile, stashImportFlash } from '../store/importFile'
import styles from './PlotSelector.module.scss'

/** The lighting module's landing view: every plot this crew knows about. */
export default function PlotSelector({
  onOpen,
  startCreating = false,
}: {
  onOpen: (plotId: string) => void
  /** True when the sidebar's + brought us here: open the name form at once. */
  startCreating?: boolean
}) {
  const { entries, loaded } = usePlotIndex()
  const [creating, setCreating] = useState(startCreating)
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (startCreating) setCreating(true)
  }, [startCreating])

  const create = () => {
    const title = name.trim()
    if (!title) return
    const { plotId } = createPlot(title, venue.trim())
    setName('')
    setVenue('')
    setCreating(false)
    onOpen(plotId)
  }

  // A rig file is how most plots arrive — an MVR from the designer or a CSV
  // from Lightwright — so this page takes one directly, the same way the
  // patch selector takes a CSV. The import creates the plot, fills it, and
  // opens it; the summary rides into PlotView via stashImportFlash.
  const importFile = async (file: File | undefined) => {
    if (!file || importing) return
    setImporting(true)
    // Yield so the "Reading…" label paints before a big MVR blocks the thread.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const title = file.name.replace(/\.(csv|mvr)$/i, '').trim() || 'Imported Plot'
    const { plotId, handle } = createPlot(title)
    try {
      stashImportFlash(await importPlotFile(handle.doc, file))
      onOpen(plotId)
    } catch (error) {
      // A failed parse leaves an empty plot behind — remove it rather than
      // strand a blank "Imported Plot" in everyone's index.
      void deletePlot(plotId)
      setImportError(`Import failed: ${error instanceof Error ? error.message : 'unreadable file'}`)
    } finally {
      setImporting(false)
    }
  }

  const isRigFile = useCallback((file: File) => /\.(csv|mvr)$/i.test(file.name), [])
  const onDropFiles = useCallback(
    (files: File[]) => {
      // One plot per drop — importing five files at once would leave someone
      // guessing which of five new plots to open.
      void importFile(files[0])
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  const onReject = useCallback((files: File[]) => {
    setImportError(`${files[0].name} isn’t a CSV or MVR`)
  }, [])
  const drop = useFileDrop(onDropFiles, { disabled: importing, accept: isRigFile, onReject })

  return (
    <div className={`${styles.selector} ${drop.over ? styles.dropping : ''}`} {...drop.handlers}>
      {drop.over && (
        <div className={styles.dropVeil}>Drop a CSV or MVR to import it as a new plot</div>
      )}
      <header className={styles.hero}>
        <div className={styles.heroTop}>
          <DrawerButton />
          <h1>Lighting Plots</h1>
        </div>
        <p className={styles.sub}>
          Fixture patch, rigging positions, and a plan of the rig — shared live with everyone on the
          box.
        </p>
      </header>

      <div className={styles.actions}>
        <button type="button" className={styles.createButton} onClick={() => setCreating(true)}>
          + New Plot
        </button>
        <button
          type="button"
          className={styles.importButton}
          disabled={importing}
          onClick={() => importRef.current?.click()}
          title="Import an MVR from the designer, or a CSV from Lightwright or a console"
        >
          {importing ? 'Reading…' : '⇪ Import CSV / MVR'}
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".csv,.mvr,text/csv"
          className={styles.hiddenFile}
          aria-label="Import CSV or MVR file"
          onChange={(e) => {
            void importFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>

      {importError && <p className={styles.importError}>{importError}</p>}

      {creating && (
        <div className={styles.createForm}>
          <label htmlFor="new-plot-name">Plot name</label>
          <input
            id="new-plot-name"
            className={styles.input}
            placeholder="Main Stage Rig"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            autoFocus
          />
          <label htmlFor="new-plot-venue">Venue (optional)</label>
          <input
            id="new-plot-venue"
            className={styles.input}
            placeholder="Worthy Farm"
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <div className={styles.formActions}>
            <button type="button" className={styles.createButton} onClick={create}>
              Create
            </button>
            <button type="button" className={styles.cancel} onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!loaded && entries.length === 0 && <p className={styles.empty}>Loading plots…</p>}
      {loaded && entries.length === 0 && (
        <p className={styles.empty}>
          No plots yet. Create one, or drop an MVR or CSV anywhere on this page.
        </p>
      )}

      <ul className={styles.list}>
        {entries.map((entry) => (
          <li key={entry.plotId} className={styles.item}>
            <button type="button" className={styles.open} onClick={() => onOpen(entry.plotId)}>
              <span className={styles.itemTitle}>{entry.title}</span>
              <span className={styles.itemMeta}>
                {[entry.venue, entry.date].filter(Boolean).join(' · ')}
              </span>
            </button>
            <button
              type="button"
              className={styles.delete}
              aria-label={`Delete ${entry.title}`}
              onClick={() => {
                if (
                  window.confirm(`Delete “${entry.title}” from this device and the shared index?`)
                ) {
                  void deletePlot(entry.plotId)
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
