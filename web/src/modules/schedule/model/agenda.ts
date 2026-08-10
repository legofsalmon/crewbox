import { parseClock } from '../../patch/model/changeover.ts'

/**
 * The running order, as everyone else on site needs it.
 *
 * The data already exists. A festival patch sheet is one stage's day, and
 * every act on it already carries a start time, an end time and the
 * changeover before it — imported from the production company's own
 * spreadsheet. Until now that was visible only inside Patch Sheets, which is
 * a module a stage manager, a lighting tech or the bar lead has no reason to
 * open. So the single most-consulted document on site was the one crewbox
 * held and did not show.
 *
 * This computes what to show from those sheets. It is deliberately pure: no
 * Yjs, no React, no clock of its own. `now` is passed in, because a running
 * order that is wrong for an hour twice a year — or silently wrong for
 * everyone west of UTC — is worse than no running order at all.
 */

/**
 * When a show day rolls over.
 *
 * A set at 00:30 belongs to the night that started at 19:00, not to the
 * following morning. Sorting by clock time alone puts it first in the day,
 * which is how a schedule ends up telling a stage manager the headliner is
 * on next at nine in the morning.
 *
 * 06:00 is the line: nothing at a music festival is programmed between four
 * and six, and load-ins that start at 07:00 belong to the new day.
 */
export const DAY_ROLLS_AT = 6 * 60

const DAY = 24 * 60

/**
 * Clock minutes mapped onto a continuous show day, so 00:30 sorts after
 * 23:00 rather than before 19:00.
 */
export const showMinutes = (clock: number): number => (clock < DAY_ROLLS_AT ? clock + DAY : clock)

export interface AgendaAct {
  id: string
  name: string
  stage: string
  /** Minutes into the show day, or null when the sheet gives no time. */
  start: number | null
  end: number | null
  /** Minutes of changeover before this act, 0 when nothing says. */
  changeover: number
}

/** One act, plus how it relates to now. */
export interface AgendaEntry {
  act: AgendaAct
  /** Minutes until it starts (negative once it has). */
  startsIn: number | null
  /** Minutes until it ends. */
  endsIn: number | null
}

export interface StageAgenda {
  stage: string
  /** Playing right now, if anything is. */
  onNow: AgendaEntry | null
  /** The next act due on this stage, if any is left today. */
  next: AgendaEntry | null
}

/**
 * Build one act from a patch sheet's artist row. Times that do not parse
 * become null rather than zero — a missing time must never read as midnight
 * and put an act at the top of the day.
 */
export function toAgendaAct(input: {
  id: string
  name: string
  stage: string
  startTime: string
  endTime: string
  changeover?: number
}): AgendaAct {
  const start = parseClock(input.startTime)
  const end = parseClock(input.endTime)
  const mappedStart = start === null ? null : showMinutes(start)

  // The end is derived from the set's *duration*, not mapped independently.
  // A 23:40-00:20 slot has an end clock that reads earlier than its start,
  // and mapping the two separately makes the set twenty hours long in one
  // direction or minus twenty in the other. Its length is forty minutes, and
  // that is true however the day is numbered.
  const duration = start === null || end === null ? null : (end - start + DAY) % DAY

  return {
    id: input.id,
    name: input.name.trim(),
    stage: input.stage.trim(),
    start: mappedStart,
    end: mappedStart === null || duration === null ? null : mappedStart + duration,
    changeover: input.changeover ?? 0,
  }
}

/** Now, as minutes into the same continuous show day. */
export const nowMinutes = (now: Date): number => showMinutes(now.getHours() * 60 + now.getMinutes())

/**
 * What is on, and what is next, per stage.
 *
 * Acts with no start time are carried but never chosen as "on now" or
 * "next" — a TBC slot should not silently become the answer to "who is on".
 * Stages come back in the order their next thing happens, so the busiest
 * stage is at the top of a phone screen rather than the alphabetically
 * luckiest one.
 */
export function agenda(acts: AgendaAct[], now: number): StageAgenda[] {
  const byStage = new Map<string, AgendaAct[]>()
  for (const act of acts) {
    const stage = act.stage || 'Stage'
    const list = byStage.get(stage)
    if (list) list.push(act)
    else byStage.set(stage, [act])
  }

  const stages: StageAgenda[] = []
  for (const [stage, list] of byStage) {
    const timed = list
      .filter((a): a is AgendaAct & { start: number } => a.start !== null)
      .sort((a, b) => a.start - b.start)

    // An act with no end time runs until the next one starts; without that,
    // every set on a sheet where nobody filled the end column would read as
    // over the moment it began.
    const entry = (act: AgendaAct, index: number): AgendaEntry => {
      const implied = act.end ?? timed[index + 1]?.start ?? null
      return {
        act,
        startsIn: act.start === null ? null : act.start - now,
        endsIn: implied === null ? null : implied - now,
      }
    }

    const onNowIndex = timed.findIndex((act, i) => {
      const end = act.end ?? timed[i + 1]?.start ?? null
      return act.start <= now && (end === null || end > now)
    })
    const nextIndex = timed.findIndex((act) => act.start > now)

    stages.push({
      stage,
      onNow: onNowIndex === -1 ? null : entry(timed[onNowIndex]!, onNowIndex),
      next: nextIndex === -1 ? null : entry(timed[nextIndex]!, nextIndex),
    })
  }

  // Soonest thing first. A stage with something on now outranks one whose
  // next act is in three hours; a stage that has finished for the day sinks.
  const rank = (s: StageAgenda) => (s.onNow ? -1 : (s.next?.startsIn ?? Number.POSITIVE_INFINITY))
  return stages.sort((a, b) => rank(a) - rank(b) || a.stage.localeCompare(b.stage))
}

/** "in 25 min", "in 2h 10m", "5 min ago" — for a glance, in the dark. */
export function relative(minutes: number): string {
  const abs = Math.abs(Math.round(minutes))
  if (abs === 0) return 'now'
  const h = Math.floor(abs / 60)
  const m = abs % 60
  const span = h === 0 ? `${m} min` : m === 0 ? `${h}h` : `${h}h ${m}m`
  return minutes >= 0 ? `in ${span}` : `${span} ago`
}
