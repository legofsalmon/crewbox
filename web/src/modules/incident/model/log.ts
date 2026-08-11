import {
  DAY_ROLLS_AT,
  INCIDENT_KIND_LABELS,
  type Incident,
  type IncidentKind,
  type IncidentSeverity,
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
export function showDayOf(at: number, now = new Date(at)): string {
  const shifted = new Date(now.getTime())
  if (shifted.getHours() * 60 + shifted.getMinutes() < DAY_ROLLS_AT) {
    shifted.setDate(shifted.getDate() - 1)
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`
}

export interface LogDay {
  /** YYYY-MM-DD of the show day, for a heading. */
  day: string
  lines: LogLine[]
}

/** The log, newest first, split into the nights it was written across. */
export function byShowDay(entries: Incident[]): LogDay[] {
  const days: LogDay[] = []
  for (const line of withCorrections(entries)) {
    const day = showDayOf(line.entry.at)
    const last = days[days.length - 1]
    if (last?.day === day) last.lines.push(line)
    else days.push({ day, lines: [line] })
  }
  return days
}

/** How many entries in the log matter enough to put on a sidebar badge. */
export const seriousCount = (entries: Incident[]): number =>
  entries.filter((e) => e.severity === 'serious').length
