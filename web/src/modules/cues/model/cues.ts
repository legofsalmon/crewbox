import { isLiveCue, type Cue, type User } from '@crewbox/shared'

/**
 * The words the cue lights pane uses, in one place so the pane, the lamp and
 * the tests agree. Plain and short: these are read at a glance by somebody
 * whose other hand is on a desk.
 */

/** A time to the second, in this phone's clock: cues are called in seconds. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

/** Where a cue is up to, said from the caller's side. */
export function cueStatus(cue: Cue): string {
  switch (cue.state) {
    case 'standby':
      return `Waiting for ${cue.target.name}`
    case 'ready':
      return `${cue.target.name} is standing by`
    case 'go':
      return cue.by
        ? `GO at ${clockTime(cue.goAt ?? 0)}, called by ${cue.by.name}`
        : `GO at ${clockTime(cue.goAt ?? 0)}`
    case 'stood-down':
      if (cue.by?.id === cue.target.id) return `${cue.target.name} couldn’t stand by`
      return cue.by ? `Stood down by ${cue.by.name}` : 'Stood down'
  }
}

/** How long the operator took to answer, for the history: "answered in 12 s". */
export function answeredIn(cue: Cue): string {
  if (cue.readyAt === null) return 'not answered'
  const s = Math.max(0, Math.round((cue.readyAt - cue.standbyAt) / 1000))
  return s < 60 ? `answered in ${s} s` : `answered in ${Math.round(s / 60)} min`
}

/** Live cues and history, split, each as the box ordered them (newest first). */
export function splitCues(cues: Cue[]): { live: Cue[]; done: Cue[] } {
  return { live: cues.filter(isLiveCue), done: cues.filter((cue) => !isLiveCue(cue)) }
}

/**
 * Who a standby can go to: everyone but you, online first, then by name.
 * Offline people stay in the list, marked, because the box rings their phone
 * the moment it is back on the Wi-Fi; but the person standing next to the
 * desk with their phone on is the one usually wanted.
 */
export function peopleToCue(
  users: Record<string, User>,
  online: Record<string, boolean>,
  meId: string | undefined
): { user: User; online: boolean }[] {
  return Object.values(users)
    .filter((user) => user.id !== meId)
    .map((user) => ({ user, online: online[user.id] === true }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.user.name.localeCompare(b.user.name))
}
