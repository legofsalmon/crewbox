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
  /**
   * Which show day this act belongs to, as plain YYYY-MM-DD.
   *
   * Carried, not dropped. Dropping it put every act on a stage across the
   * whole weekend onto one clock, so on the Saturday at 21:30 — with a
   * Friday headliner and a Saturday headliner both at 21:00 — "on now" was
   * Friday's band, on every phone, on the board, and over the control API.
   * The show log copies that name into a permanent record of the night.
   *
   * The convention is the one `showMinutes` already assumes: a set at 00:30
   * belongs to the night that started at 19:00, so it carries that night's
   * date, not the following morning's.
   *
   * Empty means "any day", which is what a single-day sheet with nobody
   * filling the date column looks like. Those behave exactly as before.
   */
  date: string
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
    date: input.date.trim(),
    start: mappedStart,
    end: mappedStart === null || duration === null ? null : mappedStart + duration,
    changeover: input.changeover,
  }
}

/** Now, as minutes into the same continuous show day. */
export const nowMinutes = (now: Date): number => showMinutes(now.getHours() * 60 + now.getMinutes())

/**
 * Where the festival is, as a wall clock and a show day.
 *
 * Two things read a running order: every crew phone, and the box when a
 * production desk asks over the control API. The phones read their own local
 * time, which on site is the festival's. The box reads its *process*
 * timezone — and a box imaged with UTC and driven to a field in July is an
 * hour out, so the Stream Deck at front of house and every phone in the crew
 * disagree about when the headliner is on, during the show, with nothing
 * saying why.
 *
 * `timeZone` is an IANA name (`CREWBOX_TZ`). Unset, this is the process
 * zone, which is today's behaviour and correct on a box whose clock is set
 * up properly. A name Intl cannot read falls back to the same, because a
 * typo in an environment variable must not stop a box telling anybody the
 * time.
 */
export function wallClock(now: Date, timeZone?: string): { now: number; today: string } {
  const parts = zoneParts(now, timeZone)
  const clock = parts.hour * 60 + parts.minute
  // Before the roll it is still the previous show day. Shifted through UTC
  // so the arithmetic is a plain day and never lands on a clock change.
  const at = Date.UTC(parts.year, parts.month - 1, parts.day)
  const day = new Date(clock < DAY_ROLLS_AT ? at - 24 * 60 * 60_000 : at)
  const month = String(day.getUTCMonth() + 1).padStart(2, '0')
  const date = String(day.getUTCDate()).padStart(2, '0')
  return { now: showMinutes(clock), today: `${day.getUTCFullYear()}-${month}-${date}` }
}

interface ZoneParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function zoneParts(now: Date, timeZone?: string): ZoneParts {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(now)
      const value = (type: string) => Number(parts.find((p) => p.type === type)?.value)
      const read = {
        year: value('year'),
        month: value('month'),
        day: value('day'),
        hour: value('hour'),
        minute: value('minute'),
      }
      if (!Object.values(read).some(Number.isNaN)) return read
    } catch {
      // An unusable zone name. Fall through to the process zone rather than
      // refusing to say what time it is.
    }
  }
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
  }
}

/**
 * Which show day it is, as plain YYYY-MM-DD.
 *
 * The same 06:00 line as `showMinutes`, applied to the calendar: at half past
 * midnight on the Saturday it is still Friday's show day, because the set on
 * stage started at eleven on the Friday night. Without this, a timetable
 * would change day underneath the crew halfway through the headline slot.
 */
export const showDate = (now: Date, timeZone?: string): string => wallClock(now, timeZone).today

/**
 * Whole days from one plain date to another, or null if either is unusable.
 *
 * Parsed as UTC on both sides so the answer is a count of calendar days and
 * never shifts by one across a daylight-saving boundary — which for a
 * festival in late March or October is not hypothetical.
 */
export function daysBetween(from: string, to: string): number | null {
  const parse = (text: string): number | null => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
    if (!match) return null
    const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    return Number.isNaN(ms) ? null : ms
  }
  const a = parse(from)
  const b = parse(to)
  if (a === null || b === null) return null
  return Math.round((b - a) / (24 * 60 * 60_000))
}

/**
 * What is on, and what is next, per stage.
 *
 * **`today` is not optional and this is why.** Without it every act on a
 * stage across the whole weekend landed on one clock, so on the Saturday at
 * 21:30, with a Friday headliner and a Saturday headliner both at 21:00,
 * "on now" was Friday's band — on every phone, on the board, and over the
 * control API, and from there into the show log as a permanent record of who
 * was on. Both consumers now pass the show day from `showDate`, and the
 * required parameter is what stops a third one forgetting.
 *
 * Acts dated before today are gone; acts dated after it can be "next" only
 * once today's stage has nothing left, and their countdown carries the whole
 * gap, so a stage that has finished says "in 19h" rather than "in 5 min"
 * about tomorrow lunchtime.
 *
 * An act with no date at all belongs to whatever day is being asked about,
 * which is what a single-day sheet with an empty date column looks like.
 *
 * Acts with no start time are carried but never chosen as "on now" or
 * "next" — a TBC slot should not silently become the answer to "who is on".
 * Stages come back in the order their next thing happens, so the busiest
 * stage is at the top of a phone screen rather than the alphabetically
 * luckiest one.
 */
export function agenda(acts: AgendaAct[], now: number, today: string): StageAgenda[] {
  const byStage = new Map<string, AgendaAct[]>()
  for (const act of acts) {
    const stage = act.stage || 'Stage'
    const list = byStage.get(stage)
    if (list) list.push(act)
    else byStage.set(stage, [act])
  }

  /**
   * How far into the future this act sits, in minutes, counting the days.
   *
   * Null for an act from a day that has been and gone, and for a date
   * nobody can read — both are things this must never call "on now".
   */
  const offsetOf = (act: AgendaAct): number | null => {
    if (!act.date) return 0
    const days = daysBetween(today, act.date)
    if (days === null || days < 0) return null
    return days * DAY
  }

  const stages: StageAgenda[] = []
  for (const [stage, list] of byStage) {
    const timed = list
      .map((act) => ({ act, offset: offsetOf(act) }))
      .filter(
        (a): a is { act: AgendaAct & { start: number }; offset: number } =>
          a.act.start !== null && a.offset !== null
      )
      // By when it actually happens, which across days is the start plus the
      // days between. Sorting on the clock alone is the whole bug.
      .sort((a, b) => a.act.start + a.offset - (b.act.start + b.offset))

    const startsAt = (i: number): number => timed[i]!.act.start + timed[i]!.offset

    // An act with no end time runs until the next one starts; without that,
    // every set on a sheet where nobody filled the end column would read as
    // over the moment it began. The next one is only an end if it is on the
    // same day — tomorrow's first act does not end tonight's last.
    const impliedEnd = (i: number): number | null => {
      const { act, offset } = timed[i]!
      if (act.end !== null) return act.end + offset
      const following = timed[i + 1]
      if (!following) return null
      return following.offset === offset ? startsAt(i + 1) : null
    }

    const entry = (i: number): AgendaEntry => {
      const end = impliedEnd(i)
      return {
        act: timed[i]!.act,
        startsIn: startsAt(i) - now,
        endsIn: end === null ? null : end - now,
      }
    }

    const onNowIndex = timed.findIndex((_, i) => {
      const end = impliedEnd(i)
      return startsAt(i) <= now && (end === null || end > now)
    })
    const nextIndex = timed.findIndex((_, i) => startsAt(i) > now)

    stages.push({
      stage,
      onNow: onNowIndex === -1 ? null : entry(onNowIndex),
      next: nextIndex === -1 ? null : entry(nextIndex),
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
