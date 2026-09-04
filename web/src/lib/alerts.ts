import { readPref, writePref } from './prefs.ts'

const SOUNDS_KEY = 'crewbox:sounds'

let audioCtx: AudioContext | null = null

export function soundsEnabled(): boolean {
  return readPref(SOUNDS_KEY) !== 'off'
}

export function setSoundsEnabled(on: boolean): void {
  writePref(SOUNDS_KEY, on ? 'on' : 'off')
}

function tone(freq: number, start: number, duration: number, gainValue: number): void {
  if (!audioCtx) return
  const osc = audioCtx.createOscillator()
  const gain = audioCtx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  const t = audioCtx.currentTime + start
  gain.gain.setValueAtTime(0, t)
  gain.gain.linearRampToValueAtTime(gainValue, t + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration)
  osc.connect(gain).connect(audioCtx.destination)
  osc.start(t)
  osc.stop(t + duration + 0.05)
}

/**
 * Distinct, loud two-tone chirp for mentions/DMs — synthesised so there are
 * no audio assets to load (or fail to load) on the festival LAN.
 */
export function playAlert(): void {
  if (!soundsEnabled()) return
  try {
    audioCtx ??= new AudioContext()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    tone(880, 0, 0.18, 0.4)
    tone(1320, 0.12, 0.25, 0.4)
  } catch {
    // no audio available; vibration may still land
  }
  if ('vibrate' in navigator) navigator.vibrate([120, 60, 120])
}

/** Local notification when the app is backgrounded (works fully offline). */
export function notify(title: string, body: string): void {
  if (!document.hidden) return
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    new Notification(title, { body, tag: 'crewbox-msg', icon: '/icon-192.png' })
  } catch {
    // some platforms (Android Chrome) require SW-based notifications; skip
  }
}

export function requestNotificationPermission(): void {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    void Notification.requestPermission()
  }
}

/** True when the message text @-mentions this user (or @all / @everyone). */
export function isMentioned(body: string, myName: string | undefined): boolean {
  const lower = body.toLowerCase()
  if (/@(all|everyone|channel)\b/.test(lower)) return true
  if (!myName) return false
  // Require a non-alphanumeric boundary after the name so "@Sammy" doesn't
  // mention "Sam". Names can contain regex metacharacters ("Alex (Stage 2)"),
  // so escape before building the pattern.
  const name = myName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@${name}(?![a-z0-9])`).test(lower)
}

/** What to announce about messages that arrived while nobody was looking. */
export interface MissedAlert {
  title: string
  body: string
  /** How many messages it covers, so a caller can say "and 4 more". */
  count: number
}

/**
 * The DMs and mentions a phone comes back to, as one alert.
 *
 * The chirp lived only on the live `msg` path, so it fired for a message that
 * arrived while the socket was up and for nothing else. Anything that landed
 * during an access-point roam, a box restart or a spell with the tab in the
 * background came back in the welcome's `missed` batch and went in silently.
 * On a festival site those are not edge cases — a phone walking between
 * stages roams, a box updating restarts, and a locked phone backgrounds the
 * tab — so the alert that exists to say "somebody needs you" was missing
 * exactly when somebody had been trying for a while.
 *
 * One alert, not one per message. Coming back from twenty minutes out of
 * signal to twelve chirps is not twelve times as useful as one; it is a
 * phone somebody puts face-down.
 *
 * Deliberately quiet about three things:
 *
 *  - **Anything already read.** The replay starts from a cursor, not from
 *    what this phone has seen, so it can carry messages read on this device
 *    before the drop. Announcing those would be a lie.
 *  - **Your own messages**, which is the same rule the live path has.
 *  - **The channel on screen, while the app has focus.** You are looking at
 *    it. Again the same rule as live.
 */
export function summariseMissed(input: {
  missed: readonly {
    channelId: string
    seq: number
    /** Null for a system message, which never needs anybody. */
    authorId?: string | null
    body: string
  }[]
  myId: string | undefined
  myName: string | undefined
  channels: Record<string, { kind?: string; name?: string } | undefined>
  users: Record<string, { name?: string } | undefined>
  /** Highest seq already read per channel, after the welcome has merged. */
  readState: Record<string, number>
  /** The channel on screen, when the app has focus; otherwise undefined. */
  focusedChannelId?: string | undefined
}): MissedAlert | null {
  const wanted = input.missed.filter((m) => {
    if (!m.authorId || m.authorId === input.myId) return false
    if (m.seq <= (input.readState[m.channelId] ?? 0)) return false
    if (m.channelId === input.focusedChannelId) return false
    const channel = input.channels[m.channelId]
    return channel?.kind === 'dm' || isMentioned(m.body, input.myName)
  })
  if (wanted.length === 0) return null

  const describe = (m: (typeof wanted)[number]): string => {
    const channel = input.channels[m.channelId]
    const author = input.users[m.authorId!]?.name ?? 'Someone'
    return channel?.kind === 'dm' ? author : `${author} in #${channel?.name ?? 'channel'}`
  }

  // One message reads exactly as it would have live, which is the point: a
  // roam that dropped a single DM should be indistinguishable from not
  // having roamed.
  const first = wanted[0]!
  if (wanted.length === 1) {
    return { title: describe(first), body: first.body, count: 1 }
  }

  // Several: say how many and who, because "3 messages" without a name is a
  // reason to open the app rather than an answer.
  const sources = [...new Set(wanted.map(describe))]
  const shown = sources.slice(0, 3).join(', ')
  return {
    title: `${wanted.length} messages need you`,
    body: sources.length > 3 ? `${shown} and ${sources.length - 3} more` : shown,
    count: wanted.length,
  }
}
