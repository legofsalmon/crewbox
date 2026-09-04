import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { findFixtureType } from '../model/fixtures'
import { useLiveLook, type LiveLook } from '../store/useLiveLook.ts'
import {
  fixturePoint3,
  isVertical,
  plotPivot,
  plotRadius,
  positionEnds,
  project,
  type Camera,
  type Point3,
} from '../model/geometry'
import { fixturesOnPosition } from '../model/plotDoc'
import type { Fixture, FixtureType, PlotSnapshot } from '../model/types'
import type { PlotIssues } from '../store/hooks'
import styles from './Plot3D.module.scss'

/**
 * The rig from wherever you drag it to.
 *
 * Deliberately light: SVG and a hand-rolled perspective transform, no WebGL
 * and no 3D library. The box ships as a single binary that crew pull over a
 * field connection, and this is dots on lines — it does not need megabytes
 * of renderer, and doing it this way keeps it working in the Android webview
 * and on a laptop with no usable GPU, which is what a FOH tent has.
 *
 * What it is for: seeing at a glance that the two trusses are at different
 * trims and the booms are downstage of both. What it is not for: rendering,
 * or anything you would open a visualiser to answer.
 *
 * Beams are the one exception, and only when the wire is being read. A GDTF
 * profile gives real pan and tilt in degrees, so "those six heads are all
 * pointed at the drum riser" stops being a guess — and that is a rigging
 * question, not a design one. They are drawn faintly and vanish the moment
 * levels stop arriving.
 */

const FIXTURE_R = 5

/** Beam angle in degrees for a fixture whose profile doesn't state one. */
const DEFAULT_BEAM_ANGLE = 15

/** Metres. A beam that misses the deck has to stop somewhere. */
const MAX_THROW = 15

/**
 * Where a head is pointing, as a unit vector in stage coordinates.
 *
 * Tilt 0 is straight down, which is where a hanging fixture sits at the
 * middle of its range and the only convention that makes an unfocused rig
 * draw sensibly. Positive tilt swings towards the audience; pan turns that
 * about the vertical.
 */
const beamDirection = (pan: number, tilt: number): Point3 => {
  const p = (pan * Math.PI) / 180
  const t = (tilt * Math.PI) / 180
  return {
    x: Math.sin(t) * Math.sin(p),
    y: -Math.sin(t) * Math.cos(p),
    z: -Math.cos(t),
  }
}

/** How much of the shorter canvas edge the rig should fill at zoom 1. */
const FIT = 0.78

/** The drawn deck, in metres: half-width, and how far upstage it runs. */
const DECK_HALF_WIDTH = 9
const DECK_DEPTH = 12
const DECK_STEP = 3

/**
 * Where the camera starts, and what Reset view goes back to.
 *
 * `distance` is perspective strength, not size — the view scales itself to
 * the rig (see `plotRadius`), so a club rig and a festival stage both arrive
 * filling the frame. Sizing by distance instead would leave one a speck.
 */
const HOME: Camera = { yaw: -35, pitch: 18, distance: 26 }

const statusClass: Record<Fixture['status'], string> = {
  todo: styles.fxTodo!,
  rigged: styles.fxRigged!,
  ok: styles.fxOk!,
  fault: styles.fxFault!,
}

/**
 * Where a fixture's beam lands and how wide it is when it gets there.
 *
 * It stops at the deck, or at `MAX_THROW` for anything pointed level or up —
 * a head aimed at the back wall would otherwise draw a stripe across the
 * whole view. Only fixtures whose profile gives real degrees get one.
 */
const beamFor = (
  fixture: Fixture,
  origin: Point3,
  live: LiveLook,
  customTypes: FixtureType[]
): { end: Point3; radius: number } | null => {
  if (live.pan === null && live.tilt === null) return null
  const direction = beamDirection(live.pan ?? 0, live.tilt ?? 0)
  const toDeck = direction.z < -0.05 ? origin.z / -direction.z : MAX_THROW
  const throwLength = Math.min(MAX_THROW, Math.max(0.5, toDeck))
  const angle = findFixtureType(fixture.typeId, customTypes)?.beamAngle ?? DEFAULT_BEAM_ANGLE
  return {
    end: {
      x: origin.x + direction.x * throwLength,
      y: origin.y + direction.y * throwLength,
      z: origin.z + direction.z * throwLength,
    },
    radius: throwLength * Math.tan((Math.min(120, angle) / 2) * (Math.PI / 180)),
  }
}

interface Orbit {
  pointerId: number
  x: number
  y: number
  yaw: number
  pitch: number
}

/** One thing to draw, with the depth that decides when. */
interface Drawn {
  depth: number
  node: ReactNode
}

export default function Plot3D({
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
  // Three-quarter view from house left, looking slightly down: the angle
  // that shows trim differences and stage depth at the same time.
  const look = useLiveLook(snapshot)
  const [camera, setCamera] = useState<Camera>(HOME)
  const [zoom, setZoom] = useState(1)
  const [orbit, setOrbit] = useState<Orbit | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 900, height: 520 })

  // The SVG is sized in pixels, so it has to be told when the pane changes —
  // rotating a phone, or opening the sidebar on a tablet.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect
      if (!box || box.width < 1) return
      setSize({ width: Math.round(box.width), height: Math.max(320, Math.round(box.height)) })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /**
   * The click handler, held by reference rather than depended on.
   *
   * The scene memo below rebuilds every fixture, truss and label in the rig
   * — the expensive thing this component does — and `onSelect` was in its
   * dependency list. The parent declares that callback inline, so every one
   * of its renders (a keystroke in the plot's title, a tab change, a live
   * DMX frame) minted a new function and rebuilt the whole 3D scene with it.
   *
   * Nothing about the scene *depends* on the callback: it is an event
   * handler, called long after the geometry is decided. A ref keeps it
   * current without making the geometry a function of its identity.
   */
  const select = useRef(onSelect)
  select.current = onSelect

  const pivot = useMemo(() => plotPivot(snapshot.positions), [snapshot.positions])
  const radius = useMemo(() => plotRadius(snapshot.positions, pivot), [snapshot.positions, pivot])

  /**
   * A press that has not moved far enough to be a drag yet.
   *
   * The orbit can't capture the pointer on pointerdown: capturing retargets
   * everything that follows to the canvas, so the click never reaches the
   * fixture under the finger and tapping a lamp to find its row silently
   * does nothing. Waiting for real movement means a tap stays a tap and a
   * drag becomes an orbit, which is also how a phone expects to behave.
   */
  const pendingRef = useRef<Orbit | null>(null)

  /** Far enough to mean it, in pixels. A thumb on glass never holds still. */
  const DRAG_SLOP = 4

  const onPointerDown = (e: React.PointerEvent) => {
    pendingRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, ...camera }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const start = orbit ?? pendingRef.current
    if (!start || e.pointerId !== start.pointerId) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (!orbit) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return
      e.currentTarget.setPointerCapture(e.pointerId)
      setOrbit(start)
    }
    setCamera((c) => ({
      ...c,
      yaw: start.yaw + dx * 0.4,
      // Clamped short of straight down and straight up: past vertical the
      // view flips over and there is no way to tell you are upside down.
      pitch: Math.max(-20, Math.min(80, start.pitch - dy * 0.3)),
    }))
  }

  const endOrbit = () => {
    pendingRef.current = null
    setOrbit(null)
  }

  /**
   * The rig, sorted back to front.
   *
   * A painter's algorithm rather than a depth buffer: with a few hundred
   * dots and lines it is exact enough and costs one sort. Each element is
   * keyed by its own centre depth, which is only wrong when a long truss
   * passes through a fixture — and that shows as a truss drawn over a lamp,
   * not as anything anyone would misread.
   *
   * The deck grid is not in here. It is always behind everything, and
   * sorting it honestly would let a floor line paint over a shin buster
   * standing on it.
   */
  const { grid, scene, labels } = useMemo(() => {
    /** World metres → SVG pixels, keeping the depth and scale for sorting. */
    // Pixels per projected unit, chosen so the rig's own extent fills the
    // frame. `project` already divides by the camera distance, so this
    // multiplies it back out — the two together mean distance controls how
    // strong the perspective is and zoom controls how big things are, rather
    // than one knob doing a muddled version of both.
    const pixels =
      ((FIT * Math.min(size.width, size.height)) / 2 / radius) * (camera.distance / 14) * zoom
    const to = (point: Point3) => {
      const p = project(point, camera, pivot)
      return {
        x: size.width / 2 + p.x * pixels,
        y: size.height / 2 + p.y * pixels,
        depth: p.depth,
        scale: p.scale,
      }
    }

    const gridNodes: ReactNode[] = []
    for (let x = -DECK_HALF_WIDTH; x <= DECK_HALF_WIDTH; x += DECK_STEP) {
      const a = to({ x, y: 0, z: 0 })
      const b = to({ x, y: DECK_DEPTH, z: 0 })
      gridNodes.push(
        <line key={`gx-${x}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={styles.grid} />
      )
    }
    for (let y = 0; y <= DECK_DEPTH; y += DECK_STEP) {
      const a = to({ x: -DECK_HALF_WIDTH, y, z: 0 })
      const b = to({ x: DECK_HALF_WIDTH, y, z: 0 })
      gridNodes.push(
        <line
          key={`gy-${y}`}
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          className={y === 0 ? styles.gridFront : styles.grid}
        />
      )
    }

    const items: Drawn[] = []
    const labelNodes: ReactNode[] = []
    const conflicted = (fixtureId: string) =>
      issues.conflicts.has(fixtureId) || issues.overruns.has(fixtureId)

    for (const position of snapshot.positions) {
      const [start, end] = positionEnds(position)
      const a = to(start)
      const b = to(end)
      // A grouping with no bar (see the MVR import) has nothing to draw a
      // line through, but its fixtures still have real coordinates.
      const hasBar = position.length > 0 || isVertical(position)

      if (hasBar) {
        items.push({
          depth: (a.depth + b.depth) / 2,
          node: (
            <line
              key={`pos-${position.id}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className={styles.truss}
              // Drawn at its real thickness — a 300 mm box truss — so it
              // thins with distance like everything else instead of being a
              // hairline up close and a slab at the back.
              strokeWidth={Math.max(2, 0.3 * pixels * ((a.scale + b.scale) / 2))}
            />
          ),
        })
        // Names go on last, over the rig: inside the depth sort a truss in
        // front paints out the label of the one behind it, which is exactly
        // the label you were trying to read. Set beside the end of the bar
        // rather than above it — a bar rising to the right crosses straight
        // through a label sitting over its end.
        labelNodes.push(
          <text
            key={`label-${position.id}`}
            x={a.x - 8}
            y={a.y + 4}
            textAnchor="end"
            className={styles.label}
          >
            {position.name}
          </text>
        )

        // Dropped lines to the deck. Without them a flown truss reads as a
        // line floating in the middle of the frame with no height at all.
        if (!isVertical(position) && position.z > 0.2) {
          for (const [world, screen] of [
            [start, a],
            [end, b],
          ] as const) {
            const foot = to({ x: world.x, y: world.y, z: 0 })
            items.push({
              depth: screen.depth + 0.01,
              node: (
                <line
                  key={`drop-${position.id}-${world.x.toFixed(2)}-${world.y.toFixed(2)}`}
                  x1={screen.x}
                  y1={screen.y}
                  x2={foot.x}
                  y2={foot.y}
                  className={styles.drop}
                />
              ),
            })
          }
        }
      }

      const fixtures = fixturesOnPosition(snapshot, position.id)
      fixtures.forEach((fixture, index) => {
        const world = fixturePoint3(fixture, position, index, fixtures.length)
        const point = to(world)
        // Same idea as the truss: a moving head is roughly 400 mm across,
        // and drawing it at that size is what makes the far end of the stage
        // read as further away rather than as smaller lamps. Anything less
        // and the fixtures are specks beside the bar they hang on.
        const r = Math.max(3, FIXTURE_R * point.scale, 0.2 * pixels * point.scale)

        const live = look?.get(fixture.id)
        const beam = live ? beamFor(fixture, world, live, snapshot.customTypes) : null
        if (live && beam) {
          const end = to(beam.end)
          // The cone is closed in screen space: a triangle from the lens to
          // the spread at the far end, perpendicular to the beam as drawn.
          // A projected ellipse would be more correct and no more legible at
          // the size these are on a phone.
          const dx = end.x - point.x
          const dy = end.y - point.y
          const length = Math.hypot(dx, dy) || 1
          const spread = beam.radius * pixels * end.scale
          const nx = (-dy / length) * spread
          const ny = (dx / length) * spread
          items.push({
            // Just behind the fixture, so a lamp is never hidden by its own
            // beam and a beam from upstage still passes behind one downstage.
            depth: point.depth + 0.001,
            node: (
              <polygon
                key={`beam-${fixture.id}`}
                points={`${point.x},${point.y} ${end.x + nx},${end.y + ny} ${end.x - nx},${end.y - ny}`}
                fill={live.colour ?? 'currentColor'}
                opacity={0.06 + 0.3 * live.dim}
                className={styles.beam}
              />
            ),
          })
        }

        items.push({
          depth: point.depth,
          node: (
            <g
              key={`fx-${fixture.id}`}
              className={styles.fixtureGroup}
              onClick={() => select.current(fixture.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  select.current(fixture.id)
                }
              }}
              aria-label={`${fixture.purpose || 'Fixture'}${
                fixture.unit ? `, unit ${fixture.unit}` : ''
              } on ${position.name}`}
            >
              {live?.colour && (
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={r + 3}
                  fill={live.colour}
                  opacity={live.dim * 0.7}
                  className={styles.fixtureColour}
                />
              )}
              <circle
                cx={point.x}
                cy={point.y}
                opacity={live?.dim}
                r={r}
                className={`${styles.fixture} ${statusClass[fixture.status]} ${
                  fixture.id === selectedId ? styles.fixtureSelected : ''
                }`}
              />
              {conflicted(fixture.id) && (
                <circle cx={point.x} cy={point.y} r={r + 3} className={styles.fixtureClash} />
              )}
            </g>
          ),
        })
      })
    }

    return {
      grid: gridNodes,
      scene: items.sort((a, b) => b.depth - a.depth).map((item) => item.node),
      labels: labelNodes,
    }
  }, [snapshot, issues, selectedId, camera, pivot, radius, zoom, size, look])

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
          onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.2) * 10) / 10))}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className={styles.reset}
          onClick={() => {
            setCamera(HOME)
            setZoom(1)
          }}
        >
          Reset view
        </button>
        <span className={styles.hint}>Drag to orbit</span>
      </div>

      <div className={styles.canvas} ref={canvasRef}>
        <svg
          width={size.width}
          height={size.height}
          role="img"
          aria-label={`3D view of ${snapshot.meta.title}: ${snapshot.positions.length} positions, ${snapshot.fixtures.length} fixtures`}
          className={orbit ? styles.orbiting : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endOrbit}
          onPointerCancel={endOrbit}
        >
          {grid}
          {scene}
          {labels}
        </svg>
      </div>
    </div>
  )
}
