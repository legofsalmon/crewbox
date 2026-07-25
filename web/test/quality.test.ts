import { describe, expect, it } from 'vitest'
import { classifyLatency, pushSample, rollingMedian } from '../src/lib/quality.ts'

describe('classifyLatency', () => {
  it('uses festival-tolerant boundaries', () => {
    expect(classifyLatency(0)).toBe('good')
    expect(classifyLatency(150)).toBe('good')
    expect(classifyLatency(151)).toBe('fair')
    expect(classifyLatency(400)).toBe('fair')
    expect(classifyLatency(401)).toBe('poor')
    expect(classifyLatency(5000)).toBe('poor')
  })
})

describe('rollingMedian', () => {
  it('handles empty and single samples', () => {
    expect(rollingMedian([])).toBeNull()
    expect(rollingMedian([42])).toBe(42)
  })

  it('takes the middle of odd counts and mean-of-two for even', () => {
    expect(rollingMedian([10, 30, 20])).toBe(20)
    expect(rollingMedian([10, 20, 30, 40])).toBe(25)
  })

  it('shrugs off a single spike (walking past the generator)', () => {
    expect(rollingMedian([40, 45, 2000, 42, 44])).toBe(44)
  })

  it('does not mutate its input', () => {
    const samples = [30, 10, 20]
    rollingMedian(samples)
    expect(samples).toEqual([30, 10, 20])
  })
})

describe('pushSample', () => {
  it('appends and trims to the window size', () => {
    let s: number[] = []
    for (const v of [1, 2, 3, 4, 5, 6, 7]) s = pushSample(s, v, 5)
    expect(s).toEqual([3, 4, 5, 6, 7])
  })
})
