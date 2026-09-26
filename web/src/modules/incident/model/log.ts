import {
  calendarDayIn,
  clockIn,
  INCIDENT_KIND_LABELS,
  type Incident,
  type IncidentKind,
  type IncidentSeverity,
  showDate,
  zonedInstant,
} from '@crewbox/shared'

/**
 * Reading the show log.
 *
 * Pure, like every other module's model layer: the entries come in as plain
 * data and go out arranged. Nothing here writes — the log is append-only and
 * the only writer is the socket.
 */

/**
 * The order a log is read in: newest at the top, and by when things
 * *happened* rather than when they were typed.
 *
 * The record is sequenced by `seq` and always will be — that is what makes it
 * a record. This is the view, and a stage manager reading back through a
 * night wants it in the night's order, so an entry back-dated by ten minutes
 * sits where the thing actually happened. `seq` breaks ties, so two entries
 * claiming the same minute keep the order the box learned them in.
 */
export const inLogOrder = (entries: Incident[]): Incident[] =>
  [...entries].sort((a, b) => b.at - a.at || b.seq - a.seq)

/** An entry with any corrections written under it, newest correction last. */
export interface LogLine {
  entry: Incident
  corrections: Incident[]
}

/**
 * Pair corrections with what they correct.
 *
 * A correction never replaces the entry it names — both stay, the way a
 * paper log book keeps the crossing-out. An orphan (its original is older
 * than the page loaded so far) stands on its own rather than vanishing.
 */
export function withCorrections(entries: Incident[]): LogLine[] {
  const corrections = new Map<string, Incident[]>()
  for (const entry of entries) {
    if (!entry.amends) continue
    corrections.set(entry.amends, [...(corrections.get(entry.amends) ?? []), entry])
  }
  const known = new Set(entries.map((e) => e.id))
  return inLogOrder(entries.filter((e) => !e.amends || !known.has(e.amends))).map((entry) => ({
    entry,
    corrections: [...(corrections.get(entry.id) ?? [])].sort((a, b) => a.seq - b.seq),
  }))
}

/**
 * Minutes between the thing happening and the box hearing about it.
 *
 * Worth showing when it is more than a couple of minutes: "logged 12 min
 * later" is the difference between a contemporaneous note and a recollection,
 * and anybody reading the log back later deserves to know which they have.
 */
export const loggedLate = (entry: Incident): number =>
  Math.max(0, Math.round((entry.loggedAt - entry.at) / 60_000))

export interface LogFilter {
  kind?: IncidentKind | 'all'
  severity?: IncidentSeverity | 'all'
  stage?: string
  /** Free text, matched against the words and the act name. */
  q?: string
}

/** Narrow the log. Every field is optional; an empty filter changes nothing. */
export function filterLog(entries: Incident[], filter: LogFilter): Incident[] {
  const q = filter.q?.trim().toLowerCase() ?? ''
  const stage = filter.stage?.trim().toLowerCase() ?? ''
  return entries.filter((entry) => {
    if (filter.kind && filter.kind !== 'all' && entry.kind !== filter.kind) return false
    if (filter.severity && filter.severity !== 'all' && entry.severity !== filter.severity) {
      return false
    }
    if (stage && entry.stage.trim().toLowerCase() !== stage) return false
    if (!q) return true
    return (
      entry.body.toLowerCase().includes(q) ||
      entry.actName.toLowerCase().includes(q) ||
      entry.authorName.toLowerCase().includes(q) ||
      INCIDENT_KIND_LABELS[entry.kind].toLowerCase().includes(q)
    )
  })
}

/**
 * Which show day an entry belongs to, as YYYY-MM-DD.
 *
 * The same six-in-the-morning roll the running order uses, and for the same
 * reason: the 00:30 barrier incident belongs to the night that started at
 * 19:00, not to the following morning, and a log that splits them across two
 * headings makes a stage manager read the night in two halves.
 */
export const showDayOf = (at: number, timeZone?: string): string => showDate(new Date(at), timeZone)

export interface LogDay {
  /** YYYY-MM-DD of the show day, for a heading. */
  day: string
  lines: LogLine[]
}

/** The log, newest first, split into the nights it was written across. */
export function byShowDay(entries: Incident[], timeZone?: string): LogDay[] {
  const days: LogDay[] = []
  for (const line of withCorrections(entries)) {
    const day = showDayOf(line.entry.at, timeZone)
    const last = days[days.length - 1]
    if (last?.day === day) last.lines.push(line)
    else days.push({ day, lines: [line] })
  }
  return days
}

/**
 * An entry's time, always 24-hour.
 *
 * The rest of the app follows the device's locale for a message timestamp,
 * which is right for chat. A log is different: it is read back weeks later,
 * quoted into a report, and compared against a call sheet and a running
 * order that are both in 24-hour — and "9:04" in a record of a night that
 * ran from 19:00 to 01:00 is a genuine ambiguity, not a preference. The pane
 * and the show report share this so they can never disagree.
 */
export const clockOf = (at: number, timeZone?: string): string => clockIn(at, timeZone)

/** How many entries in the log matter enough to put on a sidebar badge. */
export const seriousCount = (entries: Incident[]): number =>
  entries.filter((e) => e.severity === 'serious').length

/**
 * What the pane says of the entries waiting for the box that the phone
 * couldn't keep, after saying how many are waiting. The page holds them, and
 * they go when the box is back, but only if the app is still open then
 * (lib/unsent.ts).
 */
export function unsavedCopy(unsaved: number, waiting: number): string {
  const sends = unsaved === 1 ? 'it sends' : 'they send'
  const which =
    unsaved === waiting
      ? unsaved === 1
        ? 'It isn’t'
        : 'They aren’t'
      : `${unsaved} of them ${unsaved === 1 ? 'isn’t' : 'aren’t'}`
  return `${which} saved on this phone. Keep crewbox open until ${sends}.`
}

/** The day before a YYYY-MM-DD, by the calendar, whatever the clocks do. */
const dayBefore = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) - 24 * 60 * 60_000).toISOString().slice(0, 10)

/**
 * A typed HH:MM as an instant, read in the festival's zone (the device's when
 * the box has none), so the log shows back the time that was typed.
 */
export function typedTime(time: string, now: number, timeZone?: string): number {
  const [h, m] = time.split(':').map(Number)
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return now
  const today = calendarDayIn(now, timeZone)
  const stamped = zonedInstant(today, h * 60 + m, timeZone) ?? now
  // A time later than now is one from before midnight — 23:50 typed at
  // 00:10 is twenty minutes ago, not twenty-three hours away.
  if (stamped > now) return zonedInstant(dayBefore(today), h * 60 + m, timeZone) ?? now
  return stamped
}
