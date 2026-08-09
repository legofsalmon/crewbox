import { useEffect, useMemo } from 'react'
import { useStore } from '../../../store.ts'
import { liveSummary, syncNotice, universesInPlot } from '../model/live'
import type { PlotSnapshot } from '../model/types'
import styles from './LiveBar.module.scss'

/**
 * What the lighting network is doing, against this plot.
 *
 * Watching starts when this mounts and stops when it unmounts, so the box
 * only reports on universes somebody is actually looking at — and a plot
 * nobody has open costs nothing at all.
 *
 * The wording is careful on purpose. This never says a fixture is broken. It
 * says how many are being sent to, how many are not, and since when — because
 * a fixture at zero is indistinguishable from a fixture nobody addresses, and
 * the box only knows about the window it has been listening for.
 */
export default function LiveBar({
  snapshot,
  levels,
  onToggleLevels,
}: {
  snapshot: PlotSnapshot
  levels: boolean
  onToggleLevels: () => void
}) {
  const dmx = useStore((s) => s.dmx)
  const watchDmx = useStore((s) => s.watchDmx)

  const universes = useMemo(() => universesInPlot(snapshot.fixtures), [snapshot.fixtures])
  const key = universes.join(',')

  useEffect(() => {
    if (universes.length === 0) return
    watchDmx(universes, levels)
    return () => watchDmx([])
    // `key` stands in for the array so a re-render with the same universes
    // doesn't re-subscribe every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, levels, watchDmx])

  const summary = useMemo(
    () => liveSummary(snapshot.fixtures, dmx.everLit, dmx.universes, snapshot.customTypes),
    [snapshot.fixtures, snapshot.customTypes, dmx.everLit, dmx.universes]
  )

  if (universes.length === 0) return null

  if (!dmx.listening) {
    return (
      <div className={styles.bar}>
        <span className={styles.off}>Not watching a lighting network</span>
        <span className={styles.hint}>
          This box is not listening to Art-Net or sACN. Admin → Lighting network says how.
        </span>
      </div>
    )
  }

  const heard = dmx.universes.length
  const sync = syncNotice(summary.sync)
  const since = summary.since
    ? new Date(summary.since).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className={styles.bar}>
      <span className={styles.badge}>
        <span className={styles.dot} /> Live
      </span>
      {heard === 0 ? (
        <span className={styles.hint}>
          Listening, but none of this plot&rsquo;s {universes.length} universe
          {universes.length === 1 ? '' : 's'} has been heard.
        </span>
      ) : (
        <>
          <span className={styles.counts}>
            <strong>{summary.live}</strong> receiving
            {summary.silent > 0 && (
              <>
                {' · '}
                <strong>{summary.silent}</strong> nothing sent
              </>
            )}
            {summary.missing > 0 && (
              <>
                {' · '}
                <strong>{summary.missing}</strong> universe not heard
              </>
            )}
          </span>
          {since && <span className={styles.since}>since {since}</span>}
          {/* Which question was actually answered. Judging a whole footprint
              calls a parked moving head "receiving" the moment the desk
              boots; judging its dimmer alone does not, and the two counts
              are different enough to be worth saying which one this is. */}
          {summary.profiled > 0 && (
            <span className={styles.basis}>
              {summary.profiled === snapshot.fixtures.length
                ? 'by dimmer'
                : `${summary.profiled} by dimmer`}
            </span>
          )}
        </>
      )}
      {summary.conflicts.map((c) => (
        <span key={c.universe} className={styles.conflict}>
          ⚠ {c.sources} sources on universe {c.universe}
        </span>
      ))}
      {/* Not a warning by default: data held for synchronisation is the
          system working. It is here because it changes what the numbers
          above mean, and because a sync stream that has died leaves a stage
          frozen while the desk carries on — which looks like nothing at all
          from either end. */}
      {sync && (
        <span className={sync.tone === 'warn' ? styles.conflict : styles.basis}>{sync.text}</span>
      )}
      {/* The drawings stay plain paperwork until Levels is on, so without
          this line a live rig looks dead and nothing hints the toggle
          exists. Shown only when there is actually something to see. */}
      {!levels && summary.live > 0 && (
        <span className={styles.basis}>Desk is sending — Levels shows it on the drawings</span>
      )}
      <button
        type="button"
        className={`${styles.toggle} ${levels ? styles.toggleOn : ''}`}
        onClick={onToggleLevels}
        aria-pressed={levels}
        title="Dim and colour the drawings by what the desk is sending each fixture"
      >
        Levels
      </button>
    </div>
  )
}
