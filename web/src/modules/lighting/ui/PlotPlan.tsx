import { useMemo, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { useLiveLook } from '../store/useLiveLook.ts'
import { fixturePoint3, positionEnds } from '../model/geometry'
import { fixturesOnPosition, updatePosition } from '../model/plotDoc'
import type { Fixture, PlotSnapshot, Position } from '../model/types'
import type { PlotIssues } from '../store/hooks'
import styles from './PlotPlan.module.scss'

/**
 * A schematic plan of the rig, not a CAD drawing.
 *
 * Positions are line segments placed in metres; the fixtures on each one are
 * spread evenly along it in unit order. That is enough to answer the
 * question people actually have on site — "which fixture is that one, third
 * from the end of the upstage truss?" — without pretending to be Vectorworks.
 *
 * Stage convention: the audience is at the bottom, so y increases upstage
 * and the SVG flips it. x runs stage left to right as the audience sees it.
 */

/** Pixels per metre at zoom 1. */
const SCALE = 28
const FIXTURE_R = 6

interface Drag {
  positionId: string
  pointerId: number
  /** Offset from the position's origin to the grab point, in metres. */
  dx: number
  dy: number
}

/** The last snapped point a drag actually committed. See `moveDrag`. */
interface Committed {
  x: number
  y: number
}

const statusClass: Record<Fixture['status'], string> = {
  todo: styles.fxTodo!,
  rigged: styles.fxRigged!,
  ok: styles.fxOk!,
  fault: styles.fxFault!,
}

export default function PlotPlan({
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
  // Live state dims the fixture and haloes it in the colour it's being asked
  // for; the dot itself keeps its status colour, because a plot is paperwork
  // first and a monitor second.
  const look = useLiveLook(snapshot)
  const svgRef = useRef<SVGSVGElement>(null)
  const [zoom, setZoom] = useState(1)
  const [drag, setDrag] = useState<Drag | null>(null)
  // A ref, not state: it is read and written inside one pointermove and must
  // not schedule a render of its own.
  const committed = useRef<Committed | null>(null)

  /** Bounds in metres, padded, so the whole rig fits whatever its extent. */
  const bounds = useMemo(() => {
    const xs: number[] = [-6, 6]
    const ys: number[] = [-1, 8]
    for (const position of snapshot.positions) {
      const half = position.length / 2
      xs.push(position.x - half, position.x + half)
      ys.push(position.y - half, position.y + half)
    }
    for (const fixture of snapshot.fixtures) {
      if (fixture.x !== null) xs.push(fixture.x)
      if (fixture.y !== null) ys.push(fixture.y)
    }
    const pad = 2
    return {
      minX: Math.min(...xs) - pad,
      maxX: Math.max(...xs) + pad,
      minY: Math.min(...ys) - pad,
      maxY: Math.max(...ys) + pad,
    }
  }, [snapshot.positions, snapshot.fixtures])

  const width = (bounds.maxX - bounds.minX) * SCALE * zoom
  const height = (bounds.maxY - bounds.minY) * SCALE * zoom

  /** Metres → SVG pixels, flipping y so upstage is at the top. */
  const px = (x: number) => (x - bounds.minX) * SCALE * zoom
  const py = (y: number) => (bounds.maxY - y) * SCALE * zoom

  /** Pointer event → metres, for dragging positions. */
  const toMetres = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return null
    return {
      x: (clientX - rect.left) / (SCALE * zoom) + bounds.minX,
      y: bounds.maxY - (clientY - rect.top) / (SCALE * zoom),
    }
  }

  const startDrag = (e: React.PointerEvent, position: Position) => {
    const point = toMetres(e.clientX, e.clientY)
    if (!point) return
    e.currentTarget.setPointerCapture(e.pointerId)
    committed.current = { x: position.x, y: position.y }
    setDrag({
      positionId: position.id,
      pointerId: e.pointerId,
      dx: point.x - position.x,
      dy: point.y - position.y,
    })
  }

  const moveDrag = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return
    const point = toMetres(e.clientX, e.clientY)
    if (!point) return
    // Snap to 0.25 m — fine enough to look deliberate, coarse enough that
    // two people dragging don't fight over sub-millimetre differences.
    const snap = (value: number) => Math.round(value * 4) / 4
    const next = { x: snap(point.x - drag.dx), y: snap(point.y - drag.dy) }
    /**
     * Only when the snapped point has actually moved.
     *
     * A pointermove fires per frame, and at 0.25 m snapping most of them
     * land on the square the last one did. Each one was a Yjs transaction
     * plus an index-doc write, so a two-second drag of one truss put a
     * hundred-odd updates on the relay and into IndexedDB, and every other
     * device in the plot re-rendered for each — for a position that spent
     * most of that drag exactly where it already was.
     */
    if (next.x === committed.current?.x && next.y === committed.current.y) return
    committed.current = next
    updatePosition(doc, drag.positionId, next)
  }

  const endDrag = () => {
    committed.current = null
    setDrag(null)
  }

  const conflicted = (fixtureId: string) =>
    issues.conflicts.has(fixtureId) || issues.overruns.has(fixtureId)

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
        <span className={styles.hint}>Drag a position to move it</span>
      </div>

      <div className={styles.canvas}>
        <svg
          ref={svgRef}
          width={width}
          height={height}
          role="img"
          aria-label={`Plan of ${snapshot.meta.title}: ${snapshot.positions.length} positions, ${snapshot.fixtures.length} fixtures`}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {/* Centre line and the downstage edge, so the plan has a stage in it. */}
          <line
            x1={px(0)}
            y1={0}
            x2={px(0)}
            y2={height}
            className={styles.centreLine}
            strokeDasharray="4 6"
          />
          <line x1={0} y1={py(0)} x2={width} y2={py(0)} className={styles.stageEdge} />
          <text x={px(0) + 6} y={py(0) - 6} className={styles.axisLabel}>
            Downstage
          </text>

          {snapshot.positions.map((position) => {
            const [start, end] = positionEnds(position)
            const fixtures = fixturesOnPosition(snapshot, position.id)

            const hasBar = position.length > 0

            return (
              <g key={position.id}>
                {hasBar && (
                  <line
                    x1={px(start.x)}
                    y1={py(start.y)}
                    x2={px(end.x)}
                    y2={py(end.y)}
                    className={`${styles.position} ${drag?.positionId === position.id ? styles.positionDragging : ''}`}
                    onPointerDown={(e) => startDrag(e, position)}
                  />
                )}
                {/* Only a drawn bar gets a label. Role groupings interleave
                    on the same trusses, so labelling their centroids stacks
                    four names on one spot and says nothing true about where
                    anything is. */}
                {hasBar && (
                  <text x={px(start.x)} y={py(start.y) - 10} className={styles.positionLabel}>
                    {position.name}
                  </text>
                )}

                {fixtures.map((fixture, index) => {
                  const point = fixturePoint3(fixture, position, index, fixtures.length)
                  const isSelected = fixture.id === selectedId
                  const live = look?.get(fixture.id)
                  const r = FIXTURE_R * Math.min(1.6, zoom)
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
                      } on ${position.name}`}
                    >
                      {live?.colour && (
                        <circle
                          cx={px(point.x)}
                          cy={py(point.y)}
                          r={r + 3}
                          fill={live.colour}
                          opacity={live.dim * 0.7}
                          className={styles.fixtureColour}
                        />
                      )}
                      <circle
                        cx={px(point.x)}
                        cy={py(point.y)}
                        opacity={live?.dim}
                        r={r}
                        className={`${styles.fixture} ${statusClass[fixture.status]} ${
                          isSelected ? styles.fixtureSelected : ''
                        }`}
                      />
                      {conflicted(fixture.id) && (
                        <circle
                          cx={px(point.x)}
                          cy={py(point.y)}
                          r={r + 3}
                          className={styles.fixtureClash}
                        />
                      )}
                      {zoom >= 1.2 && fixture.unit && (
                        <text
                          x={px(point.x)}
                          y={py(point.y) + FIXTURE_R * 3}
                          className={styles.fixtureLabel}
                        >
                          {fixture.unit}
                        </text>
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
