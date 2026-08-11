/**
 * The running order, and the maths for reading it.
 *
 * Times are plain "HH:MM" strings, parsed where they are used, never Date.
 *
 * This lives in shared rather than in the app because two things now answer
 * "who is on": every phone's sidebar, and the box itself when a production
 * desk asks over the control API. Two implementations of a show day that
 * rolls over at six in the morning is two chances to tell a stage manager the
 * headliner is on at nine — so there is one, and both sides read it.
 *
 * Deliberately pure: no Yjs, no React, no clock of its own. `now` is passed
 * in, because a running order that is wrong for an hour twice a year, or
 * silently wrong for everyone west of UTC, is worse than no running order.
 */

/** Minutes past midnight, or null. Accepts "19:00", "19.00", "9:05". */
export function parseClock(text: string): number | null {
  const match = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*$/.exec(text)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

export interface Act {
  id: string
  name: string
  /** Which stage, room or area. Free text — it is whatever the poster says. */
  stage: string
  /** Plain YYYY-MM-DD, so a multi-day festival is one timetable. */
  date: string
  /** "19:00". Empty when the slot is still TBC. */
  start: string
  end: string
  /**
   * Minutes between the previous act coming down and this one going on.
   * 0 when nothing says — including the first act of the day, which has no
   * act before it to change over from.
   */
  changeover: number
}

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

/**
 * Acts in the order the day runs: by date, then by the show clock.
 *
 * Shared by everything that draws a list of acts — the running order's own
 * editor and every sheet that takes its columns from here — so a patch sheet
 * and the board can never put the same two acts in a different order.
 *
 * Anything without a time yet goes last, in the order it was entered. A TBC
 * slot at the head of a running order is the least certain thing in the most
 * prominent place, and on a sheet it would be the first column. Ties keep
 * their entry order, so nothing shuffles under a finger mid-edit.
 */
export const inRunningOrder = <T extends Act>(acts: T[]): T[] =>
  acts
    .map((act, index) => ({ act, index, start: toAgendaAct(act).start }))
    .sort(
      (a, b) => blankLast(a.act.date, b.act.date) || nullLast(a.start, b.start) || a.index - b.index
    )
    .map((entry) => entry.act)

const blankLast = (a: string, b: string): number =>
  a === b ? 0 : !a ? 1 : !b ? -1 : a.localeCompare(b)

const nullLast = (a: number | null, b: number | null): number =>
  a === null || b === null ? (a === b ? 0 : a === null ? 1 : -1) : a - b

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
 * Place one timetable act on the show-day line. Times that do not parse
 * become null rather than zero — a missing time must never read as midnight
 * and put an act at the top of the day.
 */
export function toAgendaAct(input: Act): AgendaAct {
  const start = parseClock(input.start)
  const end = parseClock(input.end)
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
    changeover: input.changeover,
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
