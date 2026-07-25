import type { LatencyClass } from '../lib/quality.ts'

/** 3-bar signal strength glyph: good = 3, fair = 2, poor = 1. */
export default function SignalBars({
  quality,
  size = 16,
}: {
  quality: LatencyClass
  size?: number
}) {
  const lit = quality === 'good' ? 3 : quality === 'fair' ? 2 : 1
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={`signal-bars signal-${quality}`}
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={i * 5.5}
          y={10 - i * 4}
          width="4"
          height={6 + i * 4}
          rx="1.2"
          className={i < lit ? 'bar-on' : 'bar-off'}
        />
      ))}
    </svg>
  )
}
