import { useEffect } from 'react'
import { countdownFor } from '@crewbox/shared'
import { useStore } from '../store.ts'
import { useTimetable } from '../shell/timetable/store.ts'
import { isIosApp } from '../lib/server.ts'

/**
 * Keeps the iPhone's lock-screen countdown in step with the running order.
 *
 * On Android the alerts service hears the box's `stages` frame and draws the
 * countdown itself. On the iPhone only the app's own process can update a
 * Live Activity, so the page does: with the box's maths (`countdownFor`), in
 * this phone's zone, whenever the running order changes and whenever the app
 * is looked at again. Between those, the activity counts with the phone's
 * clock, and goes stale a little after the next set is due on.
 *
 * Draws nothing.
 */
export default function LockScreenCountdown() {
  const stage = useStore((s) => s.lockScreenStage)
  const show = useStore((s) => s.showLockScreenCountdown)
  const { snapshot } = useTimetable()

  useEffect(() => {
    if (!stage || !isIosApp()) return
    const send = () => {
      if (document.hidden) return
      show(countdownFor(snapshot.acts, [stage], new Date())[0] ?? null)
    }
    send()
    document.addEventListener('visibilitychange', send)
    return () => document.removeEventListener('visibilitychange', send)
  }, [stage, show, snapshot.acts])

  return null
}
