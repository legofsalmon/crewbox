import type * as Y from 'yjs'
import { useDraft } from '../../_shared/ui/useDraft'
import { formatAddress } from '../model/addressing'
import type { FixtureVerdict } from '../model/live'
import { allFixtureTypes, findFixtureType, footprintFor } from '../model/fixtures'
import { updateFixture } from '../model/plotDoc'
import {
  FIXTURE_STATUS_LABELS,
  FIXTURE_STATUSES,
  type Fixture,
  type FixtureStatus,
  type FixtureType,
} from '../model/types'
import styles from './FixtureList.module.scss'

/** Text cell bound to one string field of a fixture. */
function TextCell({
  doc,
  fixture,
  field,
  label,
  className,
  inputMode,
}: {
  doc: Y.Doc
  fixture: Fixture
  field: 'channel' | 'unit' | 'purpose' | 'circuit' | 'mode' | 'notes'
  label: string
  className?: string
  inputMode?: 'numeric' | 'text'
}) {
  const draft = useDraft(fixture[field], (next) =>
    updateFixture(doc, fixture.id, { [field]: next })
  )
  return (
    <input
      type="text"
      className={`${styles.cellInput} ${className ?? ''}`}
      aria-label={`${label}, ${fixture.purpose || fixture.channel || 'fixture'}`}
      inputMode={inputMode}
      {...draft.inputProps}
    />
  )
}

/** Numeric cell. Blank commits as null (unknown) rather than zero. */
function NumberCell({
  doc,
  fixture,
  field,
  label,
  min,
}: {
  doc: Y.Doc
  fixture: Fixture
  field: 'universe' | 'address' | 'footprint' | 'watts' | 'weight'
  label: string
  min: number
}) {
  const current = fixture[field]
  const nullable = field === 'watts' || field === 'weight'
  const shown = current === null || (!nullable && current === 0) ? '' : String(current)

  const draft = useDraft(shown, (next) => {
    const trimmed = next.trim()
    if (!trimmed) {
      updateFixture(doc, fixture.id, { [field]: nullable ? null : 0 })
      return
    }
    const value = Number(trimmed)
    if (!Number.isFinite(value) || value < min) return
    updateFixture(doc, fixture.id, { [field]: Math.floor(value * 100) / 100 })
  })

  return (
    <input
      type="text"
      className={`${styles.cellInput} ${styles.numeric}`}
      aria-label={`${label}, ${fixture.purpose || fixture.channel || 'fixture'}`}
      inputMode="numeric"
      {...draft.inputProps}
    />
  )
}

/**
 * Type picker. Choosing a type (or a mode) seeds the footprint from the
 * library but never overwrites a footprint someone typed themselves — an
 * unusual mode has to win over the catalogue.
 */
function TypeCell({
  doc,
  fixture,
  customTypes,
}: {
  doc: Y.Doc
  fixture: Fixture
  customTypes: FixtureType[]
}) {
  const types = allFixtureTypes(customTypes)
  const selected = findFixtureType(fixture.typeId, customTypes)

  const applyType = (typeId: string) => {
    const type = findFixtureType(typeId, customTypes)
    // Default to the type's first mode rather than leaving it blank. Blank
    // meant the footprint stayed at 1, so picking "Moving spot" and moving
    // on left a 16-channel head claiming one channel — collision detection
    // would then miss every overlap it caused. A visible first mode is a
    // guess the Mode column shows and anyone can correct; a silent 1 is not.
    const mode = type?.modes[0]?.name ?? ''
    const footprint = footprintFor(typeId, mode, customTypes)
    updateFixture(doc, fixture.id, {
      typeId,
      mode,
      ...(footprint !== null ? { footprint } : {}),
    })
  }

  const applyMode = (mode: string) => {
    const footprint = footprintFor(fixture.typeId, mode, customTypes)
    updateFixture(doc, fixture.id, { mode, ...(footprint !== null ? { footprint } : {}) })
  }

  return (
    <>
      <td className={`${styles.cell} ${styles.colType}`}>
        <select
          className={styles.cellSelect}
          aria-label={`Type, ${fixture.purpose || fixture.channel || 'fixture'}`}
          value={fixture.typeId}
          onChange={(e) => applyType(e.target.value)}
        >
          <option value="">—</option>
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      </td>
      <td className={`${styles.cell} ${styles.colMode}`}>
        {selected && selected.modes.length > 1 ? (
          <select
            className={styles.cellSelect}
            aria-label={`Mode, ${fixture.purpose || fixture.channel || 'fixture'}`}
            value={fixture.mode}
            onChange={(e) => applyMode(e.target.value)}
          >
            <option value="">—</option>
            {selected.modes.map((mode) => (
              <option key={mode.name} value={mode.name}>
                {mode.name}
              </option>
            ))}
          </select>
        ) : (
          <TextCell doc={doc} fixture={fixture} field="mode" label="Mode" />
        )}
      </td>
    </>
  )
}

/**
 * Status is a tap-cycle button rather than a dropdown: a systems check is
 * hundreds of taps in a dark tent, and "tap until it's right" beats
 * open-menu-aim-select every time.
 */
function StatusCell({ doc, fixture }: { doc: Y.Doc; fixture: Fixture }) {
  const advance = () => {
    const next = FIXTURE_STATUSES[
      (FIXTURE_STATUSES.indexOf(fixture.status) + 1) % FIXTURE_STATUSES.length
    ] as FixtureStatus
    updateFixture(doc, fixture.id, { status: next })
  }
  return (
    <button
      type="button"
      className={`${styles.status} ${styles[`status-${fixture.status}`]}`}
      onClick={advance}
      aria-label={`Status of ${fixture.purpose || fixture.channel || 'fixture'}: ${
        FIXTURE_STATUS_LABELS[fixture.status]
      }. Tap to change.`}
    >
      {FIXTURE_STATUS_LABELS[fixture.status]}
    </button>
  )
}

/**
 * What the network has been seen doing to this fixture, beside the status
 * somebody typed. Deliberately small and deliberately not a verdict on the
 * fixture: `silent` says the desk has not sent to these addresses in the
 * window the box has been listening, which is a different claim from broken.
 */
function LiveDot({ verdict }: { verdict: FixtureVerdict }) {
  const title = {
    live: 'Receiving data',
    silent: 'Nothing sent to these addresses since the box started listening',
    'no-data': 'This universe has not been heard at all',
  }[verdict]
  return (
    <span
      className={`${styles.live} ${styles[`live-${verdict}`]}`}
      title={title}
      aria-label={title}
    />
  )
}

export interface FixtureRowProps {
  doc: Y.Doc
  fixture: Fixture
  customTypes: FixtureType[]
  /** Purposes/channels of fixtures this one shares DMX channels with. */
  conflictsWith: string[]
  overruns: boolean
  selected: boolean
  onSelect: () => void
  onRemove: () => void
  /**
   * What the lighting network has been seen doing to this fixture, or null
   * when the box isn't watching one. Never means "broken" — see model/live.ts.
   */
  verdict?: FixtureVerdict | null
}

export default function FixtureRow({
  doc,
  fixture,
  customTypes,
  conflictsWith,
  overruns,
  selected,
  onSelect,
  onRemove,
  verdict,
}: FixtureRowProps) {
  const clash = conflictsWith.length > 0
  const problem = clash || overruns

  const warning = clash
    ? `DMX clash with ${conflictsWith.join(', ')}`
    : overruns
      ? `Runs past channel 512 — needs ${fixture.footprint} channels from ${fixture.address}`
      : undefined

  return (
    <tr
      className={`${styles.row} ${selected ? styles.rowSelected : ''} ${
        problem ? styles.rowProblem : ''
      }`}
      onClick={onSelect}
    >
      <td className={`${styles.cell} ${styles.colUnit}`}>
        <TextCell doc={doc} fixture={fixture} field="unit" label="Unit" inputMode="numeric" />
      </td>
      <td className={`${styles.cell} ${styles.colChannel}`}>
        <TextCell doc={doc} fixture={fixture} field="channel" label="Channel" inputMode="numeric" />
      </td>
      <td className={`${styles.cell} ${styles.colUniverse}`}>
        <NumberCell doc={doc} fixture={fixture} field="universe" label="Universe" min={1} />
      </td>
      <td className={`${styles.cell} ${styles.colAddress}`}>
        <div className={styles.addressCell}>
          <NumberCell doc={doc} fixture={fixture} field="address" label="Address" min={0} />
          {warning && (
            <span
              className={styles.warn}
              title={warning}
              aria-label={warning}
              role="img"
              data-testid="fixture-warning"
            >
              ⚠
            </span>
          )}
        </div>
      </td>
      <TypeCell doc={doc} fixture={fixture} customTypes={customTypes} />
      <td className={`${styles.cell} ${styles.colFootprint}`}>
        <NumberCell doc={doc} fixture={fixture} field="footprint" label="Footprint" min={0} />
      </td>
      <td className={`${styles.cell} ${styles.colPurpose}`}>
        <TextCell doc={doc} fixture={fixture} field="purpose" label="Purpose" />
      </td>
      <td className={`${styles.cell} ${styles.colCircuit}`}>
        <TextCell doc={doc} fixture={fixture} field="circuit" label="Circuit" />
      </td>
      <td className={`${styles.cell} ${styles.colWatts}`}>
        <NumberCell doc={doc} fixture={fixture} field="watts" label="Watts" min={0} />
      </td>
      <td className={`${styles.cell} ${styles.colWeight}`}>
        <NumberCell doc={doc} fixture={fixture} field="weight" label="Weight" min={0} />
      </td>
      <td className={`${styles.cell} ${styles.colStatus}`}>
        <StatusCell doc={doc} fixture={fixture} />
        {verdict && <LiveDot verdict={verdict} />}
      </td>
      <td className={`${styles.cell} ${styles.colNotes}`}>
        <TextCell doc={doc} fixture={fixture} field="notes" label="Notes" />
      </td>
      <td className={`${styles.cell} ${styles.colActions}`}>
        <button
          type="button"
          className={styles.removeButton}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove ${fixture.purpose || formatAddress(fixture.universe, fixture.address) || 'fixture'}`}
          title="Remove fixture"
        >
          ×
        </button>
      </td>
    </tr>
  )
}
