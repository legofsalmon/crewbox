import { useEffect, useState } from 'react'
import { useTimetable } from './store.ts'
import { agenda, nowMinutes, showDate, toAgendaAct, type StageAgenda } from '@crewbox/shared'
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
  // The show day travels with the clock. It rolls at 06:00 like everything
  // else here, so a phone watching the headline slot at half past midnight
  // does not have the timetable change day underneath it — and on a
  // multi-day festival it is what stops Friday's headliner being reported as
  // on now on the Saturday.
  const [clock, setClock] = useState(() => {
    const at = new Date()
    return { now: nowMinutes(at), today: showDate(at) }
  })

  useEffect(() => {
    const tick = () => {
      const at = new Date()
      setClock({ now: nowMinutes(at), today: showDate(at) })
    }
    const timer = setInterval(tick, TICK_MS)
    // A phone that has been locked shows the countdown from before it was
    // put away until the next tick, up to fifteen seconds later, and a
    // show-log entry written in that time is stamped with whoever was on
    // then. So tick the moment the page is looked at again.
    const onVisible = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return {
    stages: agenda(snapshot.acts.map(toAgendaAct), clock.now, clock.today),
    acts: snapshot.acts,
    loaded,
  }
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
