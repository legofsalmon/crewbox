/**
 * Changeover: the gap between one act coming down and the next going on.
 *
 * On a festival stage this is the number that decides the day. Everything
 * else on a patch sheet describes a state; this describes how long you have
 * to get from one state to the next, and it is what a crew is counting down
 * in their head from the last note of a set.
 *
 * It lives in the sheet as free text in the narrow column between two act
 * blocks — "45", "HR", sometimes nothing — and it belongs to the act it comes
 * *before*: the value in an act's column is the gap from the previous act's
 * finish to this act's start. Confirmed against a real sheet, where the
 * written values and the set times agree on all three changeovers.
 *
 * Stored as minutes rather than as whatever was typed, because "HR" is a
 * shorthand for a duration and not a thing in its own right, and because the
 * useful operations — is this shorter than the last one, does it match the
 * running order — are arithmetic.
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

/**
 * A changeover cell as minutes, or null when it says nothing.
 *
 * Liberal on purpose: this is a cell somebody types between two bands while
 * standing up. "45", "45m", "45 mins", "HR", "1hr", "1 hour", "1h30",
 * "1:30" and "90" are all things people write and all mean what they look
 * like. Anything else returns null rather than a number that would quietly
 * take part in arithmetic.
 */
export function parseChangeover(text: string): number | null {
  const raw = text.trim()
  if (!raw) return null

  // "1:30" — a duration written like a clock.
  const clock = /^(\d{1,2})\s*[:.]\s*(\d{2})$/.exec(raw)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2])

  const upper = raw.toUpperCase().replace(/\s+/g, '')

  // "HR", "1HR", "1HOUR", "2HRS", optionally with minutes after: "1HR30".
  const hours = /^(\d+)?(?:H|HR|HRS|HOUR|HOURS)(\d+)?(?:M|MIN|MINS|MINUTE|MINUTES)?$/.exec(upper)
  if (hours) {
    // A bare "HR" with no number in front of it is one hour, which is what a
    // crew means when they write it.
    const whole = hours[1] === undefined ? 1 : Number(hours[1])
    return whole * 60 + Number(hours[2] ?? 0)
  }

  // "45", "45M", "45MINS".
  const minutes = /^(\d+)(?:M|MIN|MINS|MINUTE|MINUTES)?$/.exec(upper)
  if (minutes) return Number(minutes[1])

  return null
}

/** "45 min", "1 hr", "1 hr 30". Empty for nothing to say. */
export function formatChangeover(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return ''
  const whole = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (whole === 0) return `${rest} min`
  return rest === 0 ? `${whole} hr` : `${whole} hr ${rest}`
}

/**
 * A stage day can run past midnight, so a later start reading as *earlier*
 * than the previous finish is normal rather than an error. Anything beyond
 * this is more likely two different days in one sheet than a real gap, and
 * is left unstated rather than reported as a fourteen-hour changeover.
 */
const MAX_DERIVED_GAP = 8 * 60

/** The gap the set times imply, or null when they can't say. */
export function gapBetween(previousEnd: string, nextStart: string): number | null {
  const end = parseClock(previousEnd)
  const start = parseClock(nextStart)
  if (end === null || start === null) return null
  const gap = (start - end + 24 * 60) % (24 * 60)
  return gap > MAX_DERIVED_GAP ? null : gap
}
