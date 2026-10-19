import { useCallback, useEffect, useRef, useState } from 'react'
import { timing } from '../ds/tokens.js'

/**
 * An armed button, as the design system draws one (components.md, "Undo, or
 * arm"): for what cannot be taken back or goes to a live output. The first
 * press arms it and the label says what the next press does; a second press
 * within `timing.arm` (3 s) does it. The timer, Escape or leaving the button
 * disarms it.
 *
 * Spread `props` on the button; `armed` decides the label.
 */
export function useArmed(action: () => void): {
  armed: boolean
  props: {
    'data-armed'?: 'true'
    onClick: () => void
    onBlur: () => void
    onKeyDown: (event: { key: string }) => void
  }
} {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const act = useRef(action)
  act.current = action

  const disarm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setArmed(false)
  }, [])

  useEffect(() => disarm, [disarm])

  const onClick = useCallback(() => {
    if (armed) {
      disarm()
      act.current()
      return
    }
    setArmed(true)
    timer.current = setTimeout(disarm, timing.arm)
  }, [armed, disarm])

  return {
    armed,
    props: {
      ...(armed ? { 'data-armed': 'true' as const } : {}),
      onClick,
      onBlur: disarm,
      onKeyDown: (event) => {
        if (event.key === 'Escape') disarm()
      },
    },
  }
}
