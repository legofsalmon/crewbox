import { useEffect, useState } from 'react'
import { useTimetable } from './store.ts'
import { agenda, nowMinutes, toAgendaAct, type StageAgenda } from './agenda.ts'
import type { Act } from './model.ts'

/** How often the countdowns move. Fine enough to trust, idle enough to ignore. */
const TICK_MS = 15_000

/**
 * The timetable as every consumer wants it: what is on, what is next, per
 * stage, ticking.
 *
 * Shared rather than reimplemented per module, so the sidebar, the running
 * order and anything added later cannot disagree about who is on — which,
 * on a stage at a changeover, is the one thing they must not do.
 */
export function useAgenda(): { stages: StageAgenda[]; acts: Act[]; loaded: boolean } {
  const { snapshot, loaded } = useTimetable()
  const [now, setNow] = useState(() => nowMinutes(new Date()))

  useEffect(() => {
    const timer = setInterval(() => setNow(nowMinutes(new Date())), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  return { stages: agenda(snapshot.acts.map(toAgendaAct), now), acts: snapshot.acts, loaded }
}
