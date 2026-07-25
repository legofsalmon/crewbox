/** Pure connection-quality helpers — kept side-effect free for unit tests. */

export type LatencyClass = 'good' | 'fair' | 'poor'

/**
 * Festival-tolerant thresholds: crew Wi-Fi at range routinely sits in the
 * hundreds of ms — only flag what a user would actually feel.
 */
export function classifyLatency(ms: number): LatencyClass {
  if (ms <= 150) return 'good'
  if (ms <= 400) return 'fair'
  return 'poor'
}

export const LATENCY_LABELS: Record<LatencyClass, string> = {
  good: 'Good connection',
  fair: 'Weak connection — messages may take longer',
  poor: 'Very weak connection — hangs likely, messages will queue',
}

/**
 * Median of the samples — robust against the single 2 s spike a phone gets
 * walking past a generator, unlike a mean.
 */
export function rollingMedian(samples: number[]): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

/** Fixed-size sample window: push and trim in one step. */
export function pushSample(samples: number[], value: number, max = 5): number[] {
  const next = [...samples, value]
  return next.length > max ? next.slice(next.length - max) : next
}
