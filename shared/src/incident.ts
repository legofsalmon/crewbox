/**
 * The show log: what happened, when, and who wrote it down.
 *
 * A stage manager keeps this on paper today — a running list of everything
 * that went wrong or nearly did, timestamped, which becomes the show report
 * at the end of the night and the evidence six months later when somebody
 * asks why the headliner went on forty minutes late.
 *
 * Append-only by design, which is why this is the box's ordered log rather
 * than a shared document like a patch sheet. A record of what happened must
 * not be quietly editable after the fact: a mistake is corrected by writing
 * a correction underneath it, the way a paper log book is, and both stay
 * visible. See `amends`.
 */

/**
 * What kind of thing happened. Deliberately short — a list nobody scrolls,
 * covering what actually gets written in a festival log book. Anything that
 * doesn't fit is a note, and the words matter more than the label.
 */
export const INCIDENT_KINDS = [
  'note',
  'show-stop',
  'hold',
  'delay',
  'technical',
  'medical',
  'crowd',
  'security',
  'weather',
] as const

export type IncidentKind = (typeof INCIDENT_KINDS)[number]

/**
 * How much it mattered, for skimming a long night.
 *
 * Three, because a scale with more than three points is a scale nobody
 * applies consistently at two in the morning:
 *   note    — worth recording, nothing came of it
 *   issue   — it affected the show
 *   serious — somebody was hurt, the show stopped, or it goes in a report
 */
export const INCIDENT_SEVERITIES = ['note', 'issue', 'serious'] as const

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number]

export interface Incident {
  id: string
  /** Server-assigned, monotonically increasing across the whole box. */
  seq: number
  /**
   * Who wrote it. Null once that account has been deleted — the entry
   * survives, the person doesn't, which is the same rule chat follows.
   */
  authorId: string | null
  /**
   * Their name as it was at the time, so a log read next year still says who
   * logged it after a rename. Cleared with authorId on account deletion.
   */
  authorName: string
  kind: IncidentKind
  severity: IncidentSeverity
  body: string
  /**
   * When it happened. Not the same as when it was written down: a stage
   * manager deals with the thing first and logs it once there is a hand
   * free, and the log is worthless if it says the show stopped at the moment
   * somebody finally got their phone out.
   */
  at: number
  /** When the box received it. Never editable; `at` is. */
  loggedAt: number
  /** Which stage or area, from the running order's stage names. */
  stage: string
  /**
   * What was on at the time. The id links to the running order; the name is
   * a copy on purpose, which is the one place this codebase stores one.
   * Everywhere else a stale copy is a bug — here the record has to keep
   * saying "during Night Bus" even after somebody corrects the timetable or
   * deletes the act entirely.
   */
  actId: string
  actName: string
  /**
   * The entry this one corrects, when it is a correction. Both stay in the
   * log; nothing is ever overwritten or removed.
   */
  amends?: string
  /** Present on entries that came from a client (for dedupe on retry). */
  clientMsgId?: string
}

/** Labels for the UI and the show report, in one place so they agree. */
export const INCIDENT_KIND_LABELS: Record<IncidentKind, string> = {
  note: 'Note',
  'show-stop': 'Show stop',
  hold: 'Hold',
  delay: 'Delay',
  technical: 'Technical',
  medical: 'Medical',
  crowd: 'Crowd',
  security: 'Security',
  weather: 'Weather',
}

export const INCIDENT_SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  note: 'Note',
  issue: 'Issue',
  serious: 'Serious',
}

/** Longest an entry may be. Long enough for an account, short of an essay. */
export const MAX_INCIDENT_LENGTH = 2000
