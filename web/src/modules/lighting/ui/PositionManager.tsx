import { useState } from 'react'
import type * as Y from 'yjs'
import { useDraft } from '../../_shared/ui/useDraft'
import { addPosition, removePosition, updatePosition } from '../model/plotDoc'
import {
  POSITION_KIND_LABELS,
  POSITION_KINDS,
  type PlotSnapshot,
  type Position,
  type PositionKind,
} from '../model/types'
import styles from './PositionManager.module.scss'

function PositionRow({
  doc,
  position,
  fixtureCount,
  onRemove,
}: {
  doc: Y.Doc
  position: Position
  fixtureCount: number
  onRemove: () => void
}) {
  const name = useDraft(position.name, (next) => updatePosition(doc, position.id, { name: next }))
  const length = useDraft(String(position.length), (next) => {
    const value = Number(next)
    if (Number.isFinite(value) && value > 0) updatePosition(doc, position.id, { length: value })
  })
  const rotation = useDraft(String(position.rotation), (next) => {
    const value = Number(next)
    if (Number.isFinite(value)) updatePosition(doc, position.id, { rotation: value })
  })

  return (
    <li className={styles.row}>
      <input className={styles.name} aria-label="Position name" {...name.inputProps} />
      <select
        className={styles.kind}
        aria-label={`Kind of ${position.name}`}
        value={position.kind}
        onChange={(e) => updatePosition(doc, position.id, { kind: e.target.value as PositionKind })}
      >
        {POSITION_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {POSITION_KIND_LABELS[kind]}
          </option>
        ))}
      </select>
      <label className={styles.field}>
        <span>Length m</span>
        <input
          className={styles.number}
          inputMode="numeric"
          aria-label={`Length of ${position.name} in metres`}
          {...length.inputProps}
        />
      </label>
      <label className={styles.field}>
        <span>Angle °</span>
        <input
          className={styles.number}
          inputMode="numeric"
          aria-label={`Rotation of ${position.name} in degrees`}
          {...rotation.inputProps}
        />
      </label>
      <span className={styles.count}>
        {fixtureCount} fixture{fixtureCount === 1 ? '' : 's'}
      </span>
      <button
        type="button"
        className={styles.remove}
        onClick={onRemove}
        aria-label={`Remove ${position.name}`}
        title="Remove — fixtures on it become unassigned"
      >
        ×
      </button>
    </li>
  )
}

export default function PositionManager({
  doc,
  snapshot,
  onClose,
}: {
  doc: Y.Doc
  snapshot: PlotSnapshot
  onClose: () => void
}) {
  const [newName, setNewName] = useState('')

  const counts = new Map<string, number>()
  for (const fixture of snapshot.fixtures) {
    counts.set(fixture.positionId, (counts.get(fixture.positionId) ?? 0) + 1)
  }

  const create = () => {
    const name = newName.trim()
    if (!name) return
    addPosition(doc, name)
    setNewName('')
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-label="Rigging positions"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h2>Positions</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <ul className={styles.rows}>
          {snapshot.positions.map((position) => (
            <PositionRow
              key={position.id}
              doc={doc}
              position={position}
              fixtureCount={counts.get(position.id) ?? 0}
              onRemove={() => removePosition(doc, position.id)}
            />
          ))}
        </ul>

        <div className={styles.addRow}>
          <input
            id="new-position-name"
            className={styles.name}
            placeholder="Truss 2, SL Boom, Floor…"
            aria-label="New position name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <button type="button" className={styles.add} onClick={create}>
            Add position
          </button>
        </div>

        <p className={styles.note}>
          Removing a position leaves its fixtures in place — they move to “No position” rather than
          being deleted.
        </p>
      </div>
    </div>
  )
}
