import type { Fixture, Position, PositionKind } from './types'

/**
 * Where things are in space, shared by every view of the plot.
 *
 * The plan, the front elevation and the 3D view all need the same answer to
 * "where is this fixture". Three copies of that arithmetic would drift, and
 * the drift would show as a rig that moves when you change tab.
 *
 * World axes, in metres: x runs stage left to right as the audience sees it,
 * y runs upstage (away from the audience), z runs up from the deck. Every
 * view flips whichever of those its own screen axes need.
 */

/**
 * Trim height a position gets when nobody has said otherwise, in metres.
 *
 * These are festival numbers, not theatre ones — a 6 m truss trim is what a
 * mid-sized outdoor stage runs, and it is high enough that a plot drawn
 * before anyone edits the heights still looks like a rig rather than a
 * pile of fixtures on the deck.
 */
export const DEFAULT_TRIM: Record<PositionKind, number> = {
  truss: 6,
  bar: 6,
  boom: 3,
  floor: 0,
  other: 3,
}

/**
 * A boom stands up off the deck; everything else runs level at its trim.
 *
 * This is the one place the distinction lives. Drawing a boom as a
 * horizontal line 3 m up is wrong in a way that matters — it is the
 * difference between four fixtures stacked up a stand and four fixtures
 * spread across the stage.
 */
export const isVertical = (position: Position): boolean => position.kind === 'boom'

export interface Point3 {
  x: number
  y: number
  z: number
}

/** The two ends of a position's bar, in world metres. */
export function positionEnds(position: Position): [Point3, Point3] {
  if (isVertical(position)) {
    const top = Math.max(position.z, 0.1)
    return [
      { x: position.x, y: position.y, z: 0 },
      { x: position.x, y: position.y, z: top },
    ]
  }
  const angle = (position.rotation * Math.PI) / 180
  const half = position.length / 2
  return [
    {
      x: position.x - Math.cos(angle) * half,
      y: position.y - Math.sin(angle) * half,
      z: position.z,
    },
    {
      x: position.x + Math.cos(angle) * half,
      y: position.y + Math.sin(angle) * half,
      z: position.z,
    },
  ]
}

/**
 * Where to draw a fixture.
 *
 * A fixture that came from something authoritative (MVR) knows where it
 * actually is, and that always wins — a real export groups by role as often
 * as by bar, so spreading those evenly along one line would invent a rig
 * that doesn't exist. Everything else is spaced along its position, with
 * half-gaps at each end so a single fixture lands in the middle of the bar
 * rather than on its corner.
 */
export function fixturePoint3(
  fixture: Fixture,
  position: Position,
  index: number,
  count: number
): Point3 {
  const t = count <= 1 ? 0.5 : (index + 0.5) / count
  const [a, b] = positionEnds(position)
  // x and y arrive as a pair or not at all — half a coordinate is not a
  // placement, and mixing a real x with a spread y puts fixtures nowhere.
  const placed = fixture.x !== null && fixture.y !== null
  return {
    x: placed ? fixture.x! : a.x + (b.x - a.x) * t,
    y: placed ? fixture.y! : a.y + (b.y - a.y) * t,
    // Level bars have a.z === b.z, so this is just the trim. On a boom it
    // walks up the stand.
    z: fixture.z ?? a.z + (b.z - a.z) * t,
  }
}

// --- 3D projection ----------------------------------------------------------

export interface Camera {
  /** Degrees around the vertical axis. 0 looks straight upstage. */
  yaw: number
  /** Degrees above the horizontal. Positive looks down on the rig. */
  pitch: number
  /** Camera distance from the pivot, in metres. */
  distance: number
}

export interface Projected {
  /** Screen offsets from the vanishing centre, in metres-at-unit-scale. */
  x: number
  y: number
  /** Distance from the camera. Bigger is further away. */
  depth: number
  /** Perspective foreshortening — multiply sizes by this. */
  scale: number
}

/** How hard the perspective bites. Larger is flatter, closer to isometric. */
const FOCAL = 14

/**
 * Project a world point onto the screen.
 *
 * A hand-rolled perspective transform rather than a 3D library: the box
 * ships as one binary that crew download over a field connection, and a
 * WebGL renderer is megabytes to draw what is, in the end, some dots on
 * some lines. This also keeps the view working in the Android webview and
 * in a browser with no GPU, which is what a laptop in a FOH tent is.
 */
export function project(point: Point3, camera: Camera, pivot: Point3): Projected {
  const yaw = (camera.yaw * Math.PI) / 180
  const pitch = (camera.pitch * Math.PI) / 180
  const dx = point.x - pivot.x
  const dy = point.y - pivot.y
  const dz = point.z - pivot.z

  // Spin about the vertical axis first: right stays right, upstage goes
  // into the screen.
  const right = dx * Math.cos(yaw) - dy * Math.sin(yaw)
  const into = dx * Math.sin(yaw) + dy * Math.cos(yaw)

  // Then tilt the camera down over the rig.
  const up = dz * Math.cos(pitch) - into * Math.sin(pitch)
  const depth = into * Math.cos(pitch) + dz * Math.sin(pitch)

  // Clamped so a point level with (or behind) the camera doesn't invert the
  // drawing — the near limit costs nothing at any sane orbit distance.
  const scale = FOCAL / Math.max(camera.distance + depth, 1)
  return { x: right * scale, y: -up * scale, depth, scale }
}

/** The middle of the rig, which is what the 3D camera orbits. */
export function plotPivot(positions: Position[]): Point3 {
  if (positions.length === 0) return { x: 0, y: 4, z: 3 }
  let x = 0
  let y = 0
  let top = 0
  for (const position of positions) {
    x += position.x
    y += position.y
    top = Math.max(top, position.z)
  }
  return { x: x / positions.length, y: y / positions.length, z: top / 2 }
}

/**
 * How far the rig reaches from its pivot, in metres.
 *
 * The 3D view sizes itself from this, so a 6 m club rig and a 30 m festival
 * stage both arrive filling the frame instead of one being a speck and the
 * other running off the edges. Floored so an empty plot still has a scale.
 */
export function plotRadius(positions: Position[], pivot: Point3): number {
  let radius = 4
  for (const position of positions) {
    for (const end of positionEnds(position)) {
      radius = Math.max(radius, Math.hypot(end.x - pivot.x, end.y - pivot.y, end.z - pivot.z))
    }
  }
  return radius
}
