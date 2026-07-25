import { useEffect } from 'react'
import type * as Y from 'yjs'
import { addSubBox, removeSubBox, updateSubBox } from '../model/sheetDoc'
import { STAGE_POSITIONS } from '../model/constants'
import type { SheetSnapshot, SubBox } from '../model/types'
import { useDraft } from './useDraft'
import styles from './Manager.module.scss'

function SubBoxRow({ doc, subBox }: { doc: Y.Doc; subBox: SubBox }) {
  const name = useDraft(subBox.name, (next) =>
    updateSubBox(doc, subBox.id, { name: next.trim() || subBox.name })
  )
  const inputs = useDraft(String(subBox.inputs), (next) => {
    const parsed = parseInt(next, 10)
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 64) {
      updateSubBox(doc, subBox.id, { inputs: parsed })
    }
  })
  const position = useDraft(subBox.stagePosition, (next) =>
    updateSubBox(doc, subBox.id, { stagePosition: next.trim().toUpperCase() })
  )

  return (
    <div className={styles.item}>
      <div className={styles.itemHeader}>
        <input
          className={styles.nameInput}
          type="text"
          placeholder="Sub-box name"
          aria-label="Sub-box name"
          {...name.inputProps}
        />
        <button
          type="button"
          className={styles.removeButton}
          onClick={() => removeSubBox(doc, subBox.id)}
          aria-label={`Remove ${subBox.name}`}
          title="Remove sub-box (cells keep its name as text)"
        >
          ×
        </button>
      </div>
      <div className={styles.fieldRow}>
        <div className={styles.fieldGroup}>
          <label htmlFor={`subbox-inputs-${subBox.id}`}>Inputs:</label>
          <input
            id={`subbox-inputs-${subBox.id}`}
            type="number"
            min={1}
            max={64}
            style={{ width: '70px' }}
            {...inputs.inputProps}
          />
        </div>
        <div className={styles.fieldGroup}>
          <label htmlFor={`subbox-color-${subBox.id}`}>Color:</label>
          <input
            id={`subbox-color-${subBox.id}`}
            type="color"
            value={subBox.color}
            onChange={(e) => updateSubBox(doc, subBox.id, { color: e.target.value })}
          />
        </div>
        <div className={styles.fieldGroup}>
          <label htmlFor={`subbox-pos-${subBox.id}`}>Stage position:</label>
          <input
            id={`subbox-pos-${subBox.id}`}
            type="text"
            list="dl-stage-positions"
            style={{ width: '80px' }}
            {...position.inputProps}
          />
        </div>
      </div>
    </div>
  )
}

export default function SubBoxManager({
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
        aria-labelledby="subbox-manager-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="subbox-manager-title">Sub-Box Manager</h2>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className={styles.content}>
          <datalist id="dl-stage-positions">
            {STAGE_POSITIONS.map((pos) => (
              <option key={pos} value={pos} />
            ))}
          </datalist>
          <div className={styles.controls}>
            <button type="button" className={styles.addButton} onClick={() => addSubBox(doc)}>
              + Add Sub-Box
            </button>
          </div>
          {snapshot.subBoxes.length === 0 ? (
            <div className={styles.empty}>
              <p>No sub-boxes configured yet.</p>
              <p>Sub-box names become suggestions in the grid's Sub-box column.</p>
            </div>
          ) : (
            snapshot.subBoxes.map((subBox) => (
              <SubBoxRow key={subBox.id} doc={doc} subBox={subBox} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
