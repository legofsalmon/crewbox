import { describe, expect, it } from 'vitest'
import { sparklinePaths, SPARK_H, SPARK_W } from './sparkline.ts'
import type { SeriesPoint } from './types.ts'

const point = (ts: number, min: number, avg: number, max: number): SeriesPoint => [
  ts,
  min,
  avg,
  max,
  1,
]

describe('sparklinePaths', () => {
  it('draws nothing from nothing', () => {
    const p = sparklinePaths([])
    expect(p.d).toBe('')
    expect(p.bandD).toBe('')
    expect(p.last).toBeNull()
  })

  it('centres a single point with no band', () => {
    const p = sparklinePaths([point(1000, 5, 5, 5)])
    expect(p.d).toContain(`M${SPARK_W / 2}`)
    expect(p.bandD).toBe('')
    expect(p.last).toBe(5)
  })

  it('draws a flat series as a horizontal line, not a crash', () => {
    const p = sparklinePaths([point(0, 7, 7, 7), point(60_000, 7, 7, 7)])
    // Same y at both ends (range degenerates to 1, values coincide).
    const ys = [...p.d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => m[1])
    expect(new Set(ys).size).toBe(1)
  })

  it('spans the viewbox and closes the band', () => {
    const p = sparklinePaths([point(0, 1, 2, 3), point(60_000, 2, 4, 6), point(120_000, 0, 1, 2)])
    expect(p.viewBox).toBe(`0 0 ${SPARK_W} ${SPARK_H}`)
    expect(p.bandD.endsWith('Z')).toBe(true)
    expect(p.d.startsWith('M')).toBe(true)
    expect(p.last).toBe(1)
  })

  it('maps larger values to smaller y (SVG up is down)', () => {
    const p = sparklinePaths([point(0, 0, 0, 0), point(60_000, 10, 10, 10)])
    const ys = [...p.d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]))
    expect(ys[1]).toBeLessThan(ys[0]!)
  })
})
