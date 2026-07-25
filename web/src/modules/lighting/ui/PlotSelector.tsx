import { useState } from 'react'
import DrawerButton from '../../../shell/DrawerButton.tsx'
import { createPlot, deletePlot } from '../store/docManager'
import { usePlotIndex } from '../store/hooks'
import styles from './PlotSelector.module.scss'

/** The lighting module's landing view: every plot this crew knows about. */
export default function PlotSelector({ onOpen }: { onOpen: (plotId: string) => void }) {
  const { entries, loaded } = usePlotIndex()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')

  const create = () => {
    const title = name.trim()
    if (!title) return
    const { plotId } = createPlot(title, venue.trim())
    setName('')
    setVenue('')
    setCreating(false)
    onOpen(plotId)
  }

  return (
    <div className={styles.selector}>
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
      </div>

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
        <p className={styles.empty}>No plots yet. Create one, or import a CSV once it's open.</p>
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
                if (window.confirm(`Delete “${entry.title}” from this device?`)) {
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
