import { useMemo, useState } from 'react'
import { useLiveLook } from '../store/useLiveLook.ts'
import { fixturePoint3, isVertical, positionEnds } from '../model/geometry'
import { fixturesOnPosition } from '../model/plotDoc'
import type { Fixture, PlotSnapshot } from '../model/types'
import type { PlotIssues } from '../store/hooks'
import styles from './PlotPlan.module.scss'

/**
 * The rig seen from the audience: x across, height up.
 *
 * The plan answers "which one is that" and this answers "how high is it" —
 * the question that decides whether the truss clears the video wall, whether
 * a boom fouls a wing, and whether the low truss is going to be in the
 * band's eyeline. It is the same schematic honesty as the plan: line
 * segments and dots, not a render.
 *
 * Depth is the thing an elevation loses, so it is drawn back rather than
 * ignored: anything upstage is dimmer and slightly smaller, which is enough
 * to read two trusses at the same trim as two trusses.
 */

/** Pixels per metre at zoom 1. */
const SCALE = 28
const FIXTURE_R = 6

const statusClass: Record<Fixture['status'], string> = {
  todo: styles.fxTodo!,
  rigged: styles.fxRigged!,
  ok: styles.fxOk!,
  fault: styles.fxFault!,
}

export default function PlotElevation({
  snapshot,
  issues,
  selectedId,
  onSelect,
}: {
  snapshot: PlotSnapshot
  issues: PlotIssues
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const [zoom, setZoom] = useState(1)
  const look = useLiveLook(snapshot)

  /**
   * Everything the elevation has to fit, in metres.
   *
   * Positions are walked through the same `positionEnds` the plan uses, so a
   * boom's vertical run is included rather than assumed to be a point.
   */
  const bounds = useMemo(() => {
    const xs: number[] = [-6, 6]
    // Floor to a bit of headroom, so an empty plot still draws a stage.
    const zs: number[] = [0, 8]
    for (const position of snapshot.positions) {
      const [a, b] = positionEnds(position)
      xs.push(a.x, b.x)
      zs.push(a.z, b.z)
    }
    for (const fixture of snapshot.fixtures) {
      if (fixture.x !== null) xs.push(fixture.x)
      if (fixture.z !== null) zs.push(fixture.z)
    }
    const pad = 2
    return {
      minX: Math.min(...xs) - pad,
      maxX: Math.max(...xs) + pad,
      minZ: 0,
      maxZ: Math.max(...zs) + pad,
    }
  }, [snapshot.positions, snapshot.fixtures])

  /** How far upstage anything gets, for the depth shading. */
  const depthRange = useMemo(() => {
    const ys = snapshot.positions.map((p) => p.y)
    if (ys.length === 0) return { near: 0, far: 1 }
    const near = Math.min(...ys)
    const far = Math.max(...ys)
    return { near, far: far > near ? far : near + 1 }
  }, [snapshot.positions])

  /** 1 downstage → 0.45 at the back wall. Never fully transparent. */
  const depthFade = (y: number) =>
    1 - 0.55 * Math.min(1, Math.max(0, (y - depthRange.near) / (depthRange.far - depthRange.near)))

  const width = (bounds.maxX - bounds.minX) * SCALE * zoom
  const height = (bounds.maxZ - bounds.minZ) * SCALE * zoom

  /** Metres → SVG pixels, flipping z so the deck is at the bottom. */
  const px = (x: number) => (x - bounds.minX) * SCALE * zoom
  const pz = (z: number) => (bounds.maxZ - z) * SCALE * zoom

  const conflicted = (fixtureId: string) =>
    issues.conflicts.has(fixtureId) || issues.overruns.has(fixtureId)

  // Furthest upstage first, so downstage fixtures paint over the ones behind.
  const ordered = useMemo(
    () => [...snapshot.positions].sort((a, b) => b.y - a.y),
    [snapshot.positions]
  )

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.zoomButton}
          onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.2) * 10) / 10))}
          aria-label="Zoom out"
        >
          −
        </button>
        <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className={styles.zoomButton}
          onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.2) * 10) / 10))}
          aria-label="Zoom in"
        >
          +
        </button>
        <span className={styles.hint}>Trim heights come from Positions</span>
      </div>

      <div className={styles.canvas}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Front elevation of ${snapshot.meta.title}: ${snapshot.positions.length} positions, ${snapshot.fixtures.length} fixtures`}
        >
          {/* Height rules every 2 m — an elevation with no scale on it is a
              picture, not a drawing. */}
          {Array.from({ length: Math.floor(bounds.maxZ / 2) + 1 }, (_, i) => i * 2)
            .filter((metres) => metres > 0)
            .map((metres) => (
              <g key={metres}>
                <line
                  x1={0}
                  y1={pz(metres)}
                  x2={width}
                  y2={pz(metres)}
                  className={styles.gridLine}
                />
                <text x={4} y={pz(metres) - 4} className={styles.rulerLabel}>
                  {metres} m
                </text>
              </g>
            ))}

          {/* The deck, and the centre line the whole rig is hung about. */}
          <line x1={0} y1={pz(0)} x2={width} y2={pz(0)} className={styles.stageEdge} />
          <line
            x1={px(0)}
            y1={0}
            x2={px(0)}
            y2={height}
            className={styles.centreLine}
            strokeDasharray="4 6"
          />

          {ordered.map((position) => {
            const [start, end] = positionEnds(position)
            const fixtures = fixturesOnPosition(snapshot, position.id)
            const fade = depthFade(position.y)
            // A grouping with no bar (see the MVR import) has nothing to draw
            // a line through, but its fixtures still have real heights.
            const hasBar = position.length > 0 || isVertical(position)

            return (
              <g key={position.id} opacity={fade}>
                {hasBar && (
                  <line
                    x1={px(start.x)}
                    y1={pz(start.z)}
                    x2={px(end.x)}
                    y2={pz(end.z)}
                    className={styles.positionStatic}
                  />
                )}
                {hasBar && (
                  <text
                    x={px(start.x)}
                    y={pz(Math.max(start.z, end.z)) - 10}
                    className={styles.positionLabel}
                  >
                    {position.name} · {position.z.toFixed(1)} m
                  </text>
                )}

                {fixtures.map((fixture, index) => {
                  const point = fixturePoint3(fixture, position, index, fixtures.length)
                  const isSelected = fixture.id === selectedId
                  const live = look?.get(fixture.id)
                  const r = FIXTURE_R * Math.min(1.6, zoom) * (0.75 + 0.25 * fade)
                  return (
                    <g
                      key={fixture.id}
                      className={styles.fixtureGroup}
                      onClick={() => onSelect(fixture.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onSelect(fixture.id)
                        }
                      }}
                      aria-label={`${fixture.purpose || 'Fixture'}${
                        fixture.unit ? `, unit ${fixture.unit}` : ''
                      } on ${position.name}, ${point.z.toFixed(1)} m`}
                    >
                      {live?.colour && (
                        <circle
                          cx={px(point.x)}
                          cy={pz(point.z)}
                          r={r + 3}
                          fill={live.colour}
                          opacity={live.dim * 0.7}
                          className={styles.fixtureColour}
                        />
                      )}
                      <circle
                        cx={px(point.x)}
                        cy={pz(point.z)}
                        opacity={live?.dim}
                        r={r}
                        className={`${styles.fixture} ${statusClass[fixture.status]} ${
                          isSelected ? styles.fixtureSelected : ''
                        }`}
                      />
                      {conflicted(fixture.id) && (
                        <circle
                          cx={px(point.x)}
                          cy={pz(point.z)}
                          r={r + 3}
                          className={styles.fixtureClash}
                        />
                      )}
                    </g>
                  )
                })}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
