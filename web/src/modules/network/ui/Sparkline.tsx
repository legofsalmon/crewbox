import { useMemo } from 'react'
import { sparklinePaths } from '../model/sparkline.ts'
import type { SeriesPoint } from '../model/types.ts'
import styles from './Sparkline.module.scss'

/**
 * A minute-resolution sparkline: min–max band with the average line through
 * it and a point on the latest. Inline SVG, no chart library. It is the
 * design system's sparkline (charts.md): one series is neutral, so the line
 * is the chart mark's grey and never the accent; the finding's glyph beside
 * it says whether anything is wrong.
 */
export default function Sparkline({
  points,
  label,
  unit = '',
}: {
  points: SeriesPoint[]
  /** What this measures, for the accessible name. */
  label: string
  unit?: string
}) {
  const paths = useMemo(() => sparklinePaths(points), [points])
  if (!paths.d) return null
  const latest = paths.last !== null ? `${Math.round(paths.last * 10) / 10}${unit}` : ''
  return (
    <span className={styles.spark}>
      <svg
        viewBox={paths.viewBox}
        className={styles.svg}
        role="img"
        aria-label={`${label}: ${latest || 'no data'}`}
      >
        {paths.bandD && <path d={paths.bandD} className={styles.band} />}
        <path d={paths.d} className={styles.line} fill="none" />
        {paths.lastAt && (
          <circle cx={paths.lastAt.x} cy={paths.lastAt.y} r={4} className={styles.point} />
        )}
      </svg>
      {latest && <span className={styles.value}>{latest}</span>}
    </span>
  )
}
