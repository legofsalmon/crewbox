/**
 * Fitting real fixture coordinates onto the plot's position model.
 *
 * MVR gives every fixture its own XY, while a crewbox position is a line
 * segment with fixtures spread along it. Fitting the line to the points
 * keeps what matters — which bar the fixtures are on, where that bar sits,
 * which way it runs, and the order along it — and drops the millimetre
 * precision the schematic plot was never going to show anyway.
 */

export interface FittedPosition {
  /** Centroid, in metres. */
  x: number
  y: number
  /** Degrees clockwise from horizontal. */
  rotation: number
  length: number
  /** Input indices ordered along the fitted line, for unit numbering. */
  order: number[]
  /**
   * Largest distance from a point to the fitted line, in metres — how much
   * the group is a line at all.
   *
   * Real exports need this. A Capture file groups by role ("Spots",
   * "Washes") rather than by bar, so those fixtures sit across several
   * trusses and metres off any single axis. Drawing one long bar through
   * them would be a confident lie, so callers use this to decide whether the
   * group has a bar worth drawing.
   */
  residual: number
}

const DEFAULT_LENGTH = 12

/**
 * Least-squares principal axis through the points.
 *
 * The covariance matrix's dominant eigenvector gives the direction the
 * points spread in, which for a truss-worth of fixtures is the truss. A
 * bounding box would work for an axis-aligned bar and fall apart on a
 * diagonal one, which is exactly what booms and raked positions are.
 */
export function fitPosition(points: { x: number; y: number }[]): FittedPosition {
  const order = points.map((_, i) => i)
  if (points.length === 0) {
    return { x: 0, y: 0, rotation: 0, length: DEFAULT_LENGTH, order, residual: 0 }
  }

  const mx = points.reduce((sum, p) => sum + p.x, 0) / points.length
  const my = points.reduce((sum, p) => sum + p.y, 0) / points.length

  let cxx = 0
  let cyy = 0
  let cxy = 0
  for (const point of points) {
    const dx = point.x - mx
    const dy = point.y - my
    cxx += dx * dx
    cyy += dy * dy
    cxy += dx * dy
  }

  // Coincident (or single) points have no direction to find; a horizontal
  // bar of the default length is the least surprising thing to draw.
  const spread = Math.sqrt(cxx + cyy)
  if (spread < 1e-6) {
    return { x: mx, y: my, rotation: 0, length: DEFAULT_LENGTH, order, residual: 0 }
  }

  const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
  const [ux, uy] = [Math.cos(angle), Math.sin(angle)]

  const projections = points.map((p) => (p.x - mx) * ux + (p.y - my) * uy)
  const min = Math.min(...projections)
  const max = Math.max(...projections)

  // Perpendicular distance from the axis, which is what makes a scatter
  // distinguishable from a bar.
  const residual = Math.max(...points.map((p) => Math.abs(-(p.x - mx) * uy + (p.y - my) * ux)), 0)

  order.sort((a, b) => projections[a]! - projections[b]!)

  return {
    x: mx,
    y: my,
    rotation: (angle * 180) / Math.PI,
    // A hair of padding so the end fixtures aren't drawn on the very tips.
    length: Math.max(max - min, 0.5) * 1.05,
    order,
    residual,
  }
}

/**
 * How far off a straight line a group may sit and still be drawn as a bar.
 * A truss hangs its fixtures within centimetres of its axis; a role grouping
 * spread over several trusses misses by metres.
 */
export const BAR_RESIDUAL_LIMIT = 0.75

/**
 * Whether a group of points is a physical bar worth drawing, rather than a
 * grouping whose members happen to be somewhere.
 *
 * Three points is the floor because any two are exactly collinear, so the
 * residual test is vacuous below it — two hazers at opposite corners of a
 * stage would otherwise draw a 17-metre truss straight through the rig.
 */
export const isBar = (fit: FittedPosition, count: number): boolean =>
  count >= 3 && fit.residual <= BAR_RESIDUAL_LIMIT
