import { useMemo, useState } from 'react'
import { stagePatchClashes, stagePatchFor } from '../model/stagePatch'
import type { SheetSnapshot } from '../model/types'
import styles from './StagePatch.module.scss'

/**
 * The sheet read from the stage end: one act, one box at a time, tail by tail.
 *
 * The grid is the desk's view — "what is channel 12 for this act". On the
 * deck with a fistful of tails the question is the other way round, and on
 * paper that means a second table per act per box, filled in by hand and
 * wrong the moment the grid changes. Every cell already knows its box and its
 * tail, so this is derived rather than typed: nothing here is editable, and
 * it can't disagree with the grid because it *is* the grid.
 */
export default function StagePatch({
  snapshot,
  onClose,
}: {
  snapshot: SheetSnapshot
  onClose: () => void
}) {
  // Opens on the first act: a festival sheet's lineup is in running order, so
  // that is the one going on next.
  const [artistId, setArtistId] = useState(snapshot.artists[0]?.id ?? '')
  const artist = snapshot.artists.find((a) => a.id === artistId)
  const runs = useMemo(() => stagePatchFor(snapshot, artistId), [snapshot, artistId])
  const clashes = useMemo(() => stagePatchClashes(runs), [runs])
  // A festival sheet declares every box it owns, and most acts use a few of
  // them. Showing five empty 12-ways above the three real ones buries the
  // answer, so the empties fold away — but they stay one tap out, because
  // "which box has room" is the other question this view answers.
  const [showEmpty, setShowEmpty] = useState(false)
  const used = runs.filter((run) => run.used > 0)
  const empty = runs.filter((run) => run.used === 0)
  const visible = showEmpty ? runs : used

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-label={`Stage patch for ${artist?.name ?? 'artist'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h2>Stage patch</h2>
          <select
            className={styles.artistPicker}
            aria-label="Stage patch for"
            value={artistId}
            onChange={(e) => setArtistId(e.target.value)}
          >
            {snapshot.artists.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {clashes.length > 0 && (
          <p className={styles.clash} role="status">
            ⚠ Two channels on one tail: {clashes.map((c) => `${c.box} ${c.tail}`).join(', ')}
          </p>
        )}

        <div className={styles.runs}>
          {visible.length === 0 && (
            <div className={styles.empty}>
              <p>Nothing patched to a numbered tail yet. Two steps make this page write itself:</p>
              <p>
                1. Declare the stage’s sub-boxes in <strong>Boxes</strong> — name, inputs, colour.
              </p>
              <p>
                2. In the grid, write box and tail into an act’s Sub-box cell: “PINK 3” means this
                channel arrives on tail 3 of PINK.
              </p>
            </div>
          )}
          {visible.map((run) => (
            <section key={`${run.subBox?.id ?? 'text'}-${run.name}`} className={styles.run}>
              <header className={styles.runHead}>
                {/* Only a declared box has a colour. An empty square here
                    reads as an unticked checkbox, which it isn't. */}
                {run.color && <span className={styles.swatch} style={{ background: run.color }} />}
                <span className={styles.runName}>{run.name}</span>
                {run.stagePosition && <span className={styles.pos}>{run.stagePosition}</span>}
                <span className={styles.used}>
                  {run.used}/{run.rows.length}
                </span>
              </header>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Tail</th>
                    <th scope="col">Ch</th>
                    <th scope="col">Input</th>
                    <th scope="col">Mic / DI</th>
                  </tr>
                </thead>
                <tbody>
                  {run.rows.map((row) => (
                    <tr
                      key={row.tail}
                      className={`${row.channel ? '' : styles.spare} ${
                        row.clashes.length > 0 ? styles.clashRow : ''
                      }`}
                    >
                      <th scope="row">
                        {run.name} {row.tail}
                      </th>
                      <td className={styles.channel}>
                        {row.channel?.label ?? '—'}
                        {row.clashes.length > 0 &&
                          ` + ${row.clashes.map((c) => c.label).join(', ')}`}
                      </td>
                      <td>{row.input}</td>
                      <td>{row.micDi}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>

        {empty.length > 0 && (
          <button
            type="button"
            className={styles.toggle}
            onClick={() => setShowEmpty((on) => !on)}
            aria-expanded={showEmpty}
          >
            {showEmpty
              ? 'Hide unused boxes'
              : `Show ${empty.length} unused box${empty.length === 1 ? '' : 'es'}`}
          </button>
        )}

        <p className={styles.note}>
          Derived from the sub-box cells — nothing here is typed twice. A cell reading “PINK 3” puts
          channel 3’s input on tail 3 of PINK.
        </p>
      </div>
    </div>
  )
}
