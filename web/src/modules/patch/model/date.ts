// Dates are plain YYYY-MM-DD strings end to end. They are formatted and parsed
// with string operations only — `new Date('YYYY-MM-DD')` is UTC midnight and
// shifts a day for users west of UTC, a bug v1 had.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DISPLAY_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/** Today's date in the user's local timezone as YYYY-MM-DD. */
export const todayIso = (now: Date = new Date()): string => {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** YYYY-MM-DD → DD/MM/YYYY. Returns the input unchanged if it isn't ISO-shaped. */
export const isoToDisplay = (iso: string): string => {
  const m = ISO_RE.exec(iso)
  if (!m) return iso
  return `${m[3]}/${m[2]}/${m[1]}`
}

/**
 * DD/MM/YYYY → YYYY-MM-DD, or null if the input isn't a valid date.
 *
 * "Valid" means the calendar's answer, not a range check: 31 and 12 both pass
 * a range check, and 31/02 and 31/04 are not days. A sheet dated 2026-02-31
 * matches no act on the timetable and never will, so the grid comes up empty
 * with nothing anywhere saying why — the same failure the join key has every
 * other way of producing.
 *
 * The round-trip through UTC is the check: `Date.UTC` rolls an overflowing
 * day into the next month, so a date that comes back with the month it went
 * in with is a date that exists. UTC, not local, because the arithmetic must
 * not land on a clock change.
 */
export const displayToIso = (display: string): string | null => {
  const m = DISPLAY_RE.exec(display.trim())
  if (!m) return null
  const day = Number(m[1])
  const month = Number(m[2])
  const year = Number(m[3])
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1900) return null
  const at = new Date(Date.UTC(year, month - 1, day))
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
