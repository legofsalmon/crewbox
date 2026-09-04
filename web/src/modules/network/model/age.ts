/**
 * "just now" / "4 min ago" — how old the thing on screen is.
 *
 * The verdict beside it is the box's answer at the moment it was generated,
 * and on a site that is exactly the sort of thing that changes underneath
 * somebody: a switch unplugged, a radio link dropping, a cable knocked out
 * during a changeover. The pane keeps its last report when a refresh fails,
 * which is right — offline is the default here and blanking it would be
 * worse — but with no age on screen that report reads as live whether it is
 * or not, and a green verdict from before the fault is the worst kind of
 * wrong.
 */
export function reportAge(generatedAt: number, now: number): string {
  const minutes = Math.floor((now - generatedAt) / 60_000)
  // `< 1` rather than `=== 0`, so a box whose clock jumped forward after an
  // NTP sync — handing back a timestamp in this device's future — reads as
  // "just now" rather than as "-3 min ago".
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`
}
