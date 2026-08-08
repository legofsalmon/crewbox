import type { SeriesPoint } from './types.ts'

/**
 * Pure sparkline geometry: rollup points in, SVG path strings out. Shared
 * between the live pane and the HTML export so the report's charts are the
 * same drawing, not a re-implementation.
 *
 * The shape is a min–max band (the envelope of each minute) with the
 * average drawn as a line through it — one glance says both "where it sat"
 * and "how wild it got".
 */

export const SPARK_W = 120
export const SPARK_H = 28
/** Breathing room so a flat line isn't glued to the frame's edge. */
const PAD = 2

export interface SparklinePaths {
  /** The average line. Empty string when there is nothing to draw. */
  d: string
  /** The closed min–max band behind it. */
  bandD: string
  viewBox: string
  /** Latest average, for the number beside the drawing. */
  last: number | null
}

const round = (n: number): number => Math.round(n * 100) / 100

export function sparklinePaths(points: SeriesPoint[]): SparklinePaths {
  const viewBox = `0 0 ${SPARK_W} ${SPARK_H}`
  if (points.length === 0) return { d: '', bandD: '', viewBox, last: null }

  const t0 = points[0]![0]
  const t1 = points[points.length - 1]![0]
  const span = Math.max(1, t1 - t0)
  let lo = Infinity
  let hi = -Infinity
  for (const [, min, , max] of points) {
    lo = Math.min(lo, min)
    hi = Math.max(hi, max)
  }
  const range = hi - lo || 1 // a flat series draws a centred line

  const x = (ts: number): number =>
    points.length === 1 ? SPARK_W / 2 : round(((ts - t0) / span) * (SPARK_W - PAD * 2) + PAD)
  const y = (value: number): number =>
    round(SPARK_H - PAD - ((value - lo) / range) * (SPARK_H - PAD * 2))

  const avgLine = points
    .map(([ts, , avg], i) => `${i === 0 ? 'M' : 'L'}${x(ts)} ${y(avg)}`)
    .join(' ')

  // The band: along the maxima left→right, back along the minima.
  const top = points.map(([ts, , , max], i) => `${i === 0 ? 'M' : 'L'}${x(ts)} ${y(max)}`)
  const bottom = [...points].reverse().map(([ts, min]) => `L${x(ts)} ${y(min)}`)
  const bandD = points.length > 1 ? `${top.join(' ')} ${bottom.join(' ')} Z` : ''

  return { d: avgLine, bandD, viewBox, last: points[points.length - 1]![2] }
}
