import { useState } from 'react'
import type * as Y from 'yjs'
import { useDraft } from '../../_shared/ui/useDraft'
import { addPosition, fixturesOnPosition, removePosition, updatePosition } from '../model/plotDoc'
import { describeSticks, estimateTruss } from '../model/truss'
import {
  POSITION_KIND_LABELS,
  POSITION_KINDS,
  type Fixture,
  type FixtureType,
  type PlotSnapshot,
  type Position,
  type PositionKind,
} from '../model/types'
import styles from './PositionManager.module.scss'

function PositionRow({
  doc,
  position,
  fixtures,
  customTypes,
  onRemove,
}: {
  doc: Y.Doc
  position: Position
  fixtures: Fixture[]
  customTypes: FixtureType[]
  onRemove: () => void
}) {
  const fixtureCount = fixtures.length
  const name = useDraft(position.name, (next) => updatePosition(doc, position.id, { name: next }))
  const length = useDraft(String(position.length), (next) => {
    const value = Number(next)
    if (Number.isFinite(value) && value > 0) updatePosition(doc, position.id, { length: value })
  })
  const rotation = useDraft(String(position.rotation), (next) => {
    const value = Number(next)
    if (Number.isFinite(value)) updatePosition(doc, position.id, { rotation: value })
  })
  // Trim can legitimately be 0 — a floor package sits on the deck — so this
  // one accepts zero where length doesn't. Negative would be below the stage.
  const trim = useDraft(String(position.z), (next) => {
    const value = Number(next)
    if (Number.isFinite(value) && value >= 0) updatePosition(doc, position.id, { z: value })
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
      <label className={styles.field}>
        <span>{position.kind === 'boom' ? 'Height m' : 'Trim m'}</span>
        <input
          className={styles.number}
          inputMode="numeric"
          aria-label={`Trim height of ${position.name} in metres`}
          {...trim.inputProps}
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
      <TrussEstimate doc={doc} position={position} fixtures={fixtures} customTypes={customTypes} />
    </li>
  )
}

/**
 * How much truss this position's fixtures need, and what to build it from.
 *
 * The question on the production call is "how much truss do I order", and
 * the plot already knows the fixtures. Nothing here changes the plot on its
 * own — it says what it worked out and offers to set the length, because an
 * estimate that quietly rewrote the drawing would be worse than no estimate.
 */
function TrussEstimate({
  doc,
  position,
  fixtures,
  customTypes,
}: {
  doc: Y.Doc
  position: Position
  fixtures: Fixture[]
  customTypes: FixtureType[]
}) {
  const estimate = estimateTruss(position, fixtures, customTypes)
  if (!estimate) return null

  const matches = Math.abs(position.length - estimate.built) < 0.01
  return (
    <p className={styles.estimate}>
      <span>
        Needs {estimate.needed.toFixed(1)} m{estimate.basis === 'coordinates' ? ' (measured)' : ''}{' '}
        · {describeSticks(estimate.sticks)}
        {/* Say where the widths came from. Added up from a 400 mm default,
            this is a guess with arithmetic done to it; added up from GDTF
            profiles, it is the fixtures' own dimensions. */}
        {estimate.basis === 'fixtures' && (
          <span className={styles.estimateBasis}>
            {estimate.measured === estimate.fixtureCount
              ? ' · widths from profiles'
              : estimate.measured === 0
                ? ' · widths assumed'
                : ` · ${estimate.measured} of ${estimate.fixtureCount} widths from profiles`}
          </span>
        )}
      </span>
      {!matches && (
        <button
          type="button"
          className={styles.apply}
          onClick={() => updatePosition(doc, position.id, { length: estimate.built })}
        >
          Set to {estimate.built} m
        </button>
      )}
    </p>
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
              fixtures={fixturesOnPosition(snapshot, position.id)}
              customTypes={snapshot.customTypes}
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
          being deleted. Truss estimates allow {'≈'}250 mm between fixtures and don{'’'}t know about
          motor points or corner blocks — check them before you order.
        </p>
      </div>
    </div>
  )
}
