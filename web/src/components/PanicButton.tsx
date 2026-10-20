import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { PANIC_HOLD_MS } from '@crewbox/shared'
import { useStore } from '../store.ts'
import { markHeldHere } from '../lib/panicClip.ts'

/**
 * Hold for help: two seconds held, and every phone on site rings, through
 * silent and Do Not Disturb (docs/CUES.md).
 *
 * Who: somebody working alone at height, at a generator, in a car park, who
 * may be hurt or frightened and has one hand free. One job: get help coming
 * with the least they have to do. So it is one gesture, always in the same
 * place in the drawer, and nothing to read or choose afterwards.
 *
 * Held rather than pressed, and for longer than the system's `timing.hold`
 * (500 ms), because a false alarm rings every phone on site and the crew
 * stop believing the next one (Authority Bias). The fill shows the hold
 * counting, so letting go early is a visible choice, not a mystery.
 */
export default function PanicButton() {
  const callForHelp = useStore((s) => s.callForHelp)
  const toast = useStore((s) => s.toast)
  const setSidebarOpen = useStore((s) => s.setSidebarOpen)
  const live = useStore((s) => s.panics.some((p) => p.person.id === s.me?.id))
  const [holding, setHolding] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stop = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setHolding(false)
  }
  useEffect(() => stop, [])

  const start = () => {
    if (timer.current || live) return
    setHolding(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setHolding(false)
      if (!callForHelp()) {
        toast('Can’t reach the box, so nobody was called. Use your radio or phone.', 'error')
        return
      }
      markHeldHere()
      setSidebarOpen(false)
    }, PANIC_HOLD_MS)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault()
      start()
    }
  }
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === ' ' || event.key === 'Enter') stop()
  }

  return (
    <button
      className="panic-hold"
      data-holding={holding ? 'true' : undefined}
      disabled={live}
      onPointerDown={(event) => {
        // Keep the press when a finger drifts a little on a phone.
        event.currentTarget.setPointerCapture?.(event.pointerId)
        start()
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={stop}
      onContextMenu={(event) => event.preventDefault()}
      title="Hold for two seconds to ring every phone on site"
    >
      <span className="panic-hold-fill" aria-hidden />
      <span className="panic-hold-text">
        {live ? 'Help is called' : holding ? 'Keep holding…' : 'Hold for help'}
      </span>
    </button>
  )
}
