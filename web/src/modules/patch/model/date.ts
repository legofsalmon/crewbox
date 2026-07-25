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

/** DD/MM/YYYY → YYYY-MM-DD, or null if the input isn't a valid date. */
export const displayToIso = (display: string): string | null => {
  const m = DISPLAY_RE.exec(display.trim())
  if (!m) return null
  const day = Number(m[1])
  const month = Number(m[2])
  const year = Number(m[3])
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1900) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
