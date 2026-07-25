import { useMemo } from 'react'
import type * as Y from 'yjs'
import { nextFreeAddress } from '../model/addressing'
import {
  addFixture,
  addressSequentially,
  fixturesOnPosition,
  removeFixture,
} from '../model/plotDoc'
import { POSITION_KIND_LABELS, type Fixture, type PlotSnapshot } from '../model/types'
import type { PlotIssues } from '../store/hooks'
import FixtureRow from './FixtureRow'
import styles from './FixtureList.module.scss'

/**
 * The fixture list, grouped by rigging position.
 *
 * Grouping matches how the work actually happens: you are standing at one
 * truss dealing with the fixtures on it, not scrolling a flat list of four
 * hundred. Fixtures with no position collect in a final group rather than
 * disappearing.
 */

const fixtureLabel = (fixture: Fixture): string =>
  fixture.purpose || (fixture.channel ? `Ch ${fixture.channel}` : 'fixture')

function PositionGroup({
  doc,
  snapshot,
  issues,
  positionId,
  title,
  subtitle,
  selectedId,
  onSelect,
}: {
  doc: Y.Doc
  snapshot: PlotSnapshot
  issues: PlotIssues
  positionId: string
  title: string
  subtitle?: string
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const fixtures = useMemo(() => fixturesOnPosition(snapshot, positionId), [snapshot, positionId])

  const labelById = useMemo(
    () => new Map(snapshot.fixtures.map((fixture) => [fixture.id, fixtureLabel(fixture)])),
    [snapshot.fixtures]
  )

  const totalWatts = fixtures.reduce((sum, fixture) => sum + (fixture.watts ?? 0), 0)
  const totalWeight = fixtures.reduce((sum, fixture) => sum + (fixture.weight ?? 0), 0)

  /** Pack this position's fixtures nose to tail from the first free address. */
  const addressRun = () => {
    if (fixtures.length === 0) return
    const universe = fixtures[0]!.universe
    const needed = fixtures.reduce((sum, fixture) => sum + Math.max(1, fixture.footprint), 0)
    const others = snapshot.fixtures.filter(
      (fixture) => !fixtures.some((own) => own.id === fixture.id)
    )
    const start = nextFreeAddress(others, universe, needed)
    if (start === null) {
      window.alert(
        `Universe ${universe} doesn't have ${needed} free channels in a row for this position.`
      )
      return
    }
    addressSequentially(
      doc,
      fixtures.map((fixture) => fixture.id),
      universe,
      start
    )
  }

  return (
    <section className={styles.group} aria-label={title}>
      <header className={styles.groupHead}>
        <div className={styles.groupTitle}>
          <h3>{title}</h3>
          {subtitle && <span className={styles.groupKind}>{subtitle}</span>}
        </div>
        <div className={styles.groupMeta}>
          <span>
            {fixtures.length} fixture{fixtures.length === 1 ? '' : 's'}
          </span>
          {totalWatts > 0 && <span>{totalWatts.toLocaleString()} W</span>}
          {totalWeight > 0 && <span>{Math.round(totalWeight * 10) / 10} kg</span>}
        </div>
        <div className={styles.groupActions}>
          {fixtures.length > 0 && (
            <button
              type="button"
              className={styles.groupButton}
              onClick={addressRun}
              title="Address these fixtures nose to tail from the first free address"
            >
              Address run
            </button>
          )}
          <button
            type="button"
            className={styles.groupButton}
            onClick={() => addFixture(doc, { positionId, unit: String(fixtures.length + 1) })}
          >
            + Fixture
          </button>
        </div>
      </header>

      {fixtures.length === 0 ? (
        <p className={styles.empty}>Nothing on this position yet.</p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.colUnit}>Unit</th>
                <th className={styles.colChannel}>Chan</th>
                <th className={styles.colUniverse}>Uni</th>
                <th className={styles.colAddress}>Addr</th>
                <th className={styles.colType}>Type</th>
                <th className={styles.colMode}>Mode</th>
                <th className={styles.colFootprint} title="DMX channels used">
                  Ch
                </th>
                <th className={styles.colPurpose}>Purpose</th>
                <th className={styles.colCircuit}>Circuit</th>
                <th className={styles.colWatts}>W</th>
                <th className={styles.colWeight}>kg</th>
                <th className={styles.colStatus}>Status</th>
                <th className={styles.colNotes}>Notes</th>
                <th className={styles.colActions}>
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {fixtures.map((fixture) => (
                <FixtureRow
                  key={fixture.id}
                  doc={doc}
                  fixture={fixture}
                  customTypes={snapshot.customTypes}
                  conflictsWith={(issues.conflicts.get(fixture.id) ?? []).map(
                    (id) => labelById.get(id) ?? 'another fixture'
                  )}
                  overruns={issues.overruns.has(fixture.id)}
                  selected={selectedId === fixture.id}
                  onSelect={() => onSelect(fixture.id)}
                  onRemove={() => removeFixture(doc, fixture.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default function FixtureList({
  doc,
  snapshot,
  issues,
  selectedId,
  onSelect,
}: {
  doc: Y.Doc
  snapshot: PlotSnapshot
  issues: PlotIssues
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const unassigned = snapshot.fixtures.filter((fixture) => fixture.positionId === '')

  return (
    <div className={styles.list}>
      {snapshot.positions.map((position) => (
        <PositionGroup
          key={position.id}
          doc={doc}
          snapshot={snapshot}
          issues={issues}
          positionId={position.id}
          title={position.name}
          subtitle={POSITION_KIND_LABELS[position.kind]}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}

      {(unassigned.length > 0 || snapshot.positions.length === 0) && (
        <PositionGroup
          doc={doc}
          snapshot={snapshot}
          issues={issues}
          positionId=""
          title="No position"
          selectedId={selectedId}
          onSelect={onSelect}
        />
      )}
    </div>
  )
}
