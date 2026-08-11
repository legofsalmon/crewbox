import { useEffect, useState } from 'react'
import { useTimetable } from './store.ts'
import { agenda, nowMinutes, toAgendaAct, type StageAgenda } from './agenda.ts'
import { stagesIn, type Act } from './model.ts'

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

/**
 * Stage names already on the running order.
 *
 * Offered back wherever a stage gets typed, because "Main Stage" and "Main
 * stage" are two stages to a computer and one to a crew — and a module that
 * picks its rows by stage name shows an empty screen when they disagree.
 */
export function useStageNames(): string[] {
  const { snapshot } = useTimetable()
  return stagesIn(snapshot.acts)
}
