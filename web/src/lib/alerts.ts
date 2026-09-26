import { isMentioned, levelFor, messageAlertKind, type AlertSettings } from '@crewbox/shared'
import { readPref, writePref } from './prefs.ts'
import { nativeHaptics } from './server.ts'

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
  buzz()
}

/**
 * The buzz that goes with the chirp, for a phone that is muted or a site too
 * loud to hear it.
 *
 * In the apps it is the platform's own haptic, because `navigator.vibrate`
 * never reached a phone from either of them. The iPhone's web view has no
 * vibration API at all. Android's has one, but it vibrates only for an app
 * holding VIBRATE, which crewbox did not, and only once somebody has tapped
 * the page since it loaded. `WARNING` is the haptic each platform means for
 * "this needs you": a firm buzz on Android, the system's warning tap on an
 * iPhone, each following the phone's own vibration settings.
 *
 * Only while the app is on screen, which is also the web API's own rule.
 * Once it is out of sight, Android's alerts service posts the notification
 * and that buzzes by itself; a second buzz from here would make one message
 * feel like two.
 */
function buzz(): void {
  if (document.visibilityState !== 'visible') return
  const haptics = nativeHaptics()
  if (haptics) {
    void haptics.notification({ type: 'WARNING' }).catch(() => {})
  } else if ('vibrate' in navigator) {
    navigator.vibrate([120, 60, 120])
  }
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

/**
 * True when the message text @-mentions this user (or @all / @everyone).
 *
 * The box's test, from the alerts contract, so the page, the box and the
 * phones agree on who a message is for (shared/src/alerts.ts).
 */
export { isMentioned }

/** What to announce about messages that arrived while nobody was looking. */
export interface MissedAlert {
  title: string
  body: string
  /** How many messages it covers, so a caller can say "and 4 more". */
  count: number
  /** The channel they are all in, when there is one: where it takes you. */
  channelId?: string
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
  channels: Record<string, { kind?: string; name?: string; memberIds?: string[] } | undefined>
  users: Record<string, { name?: string } | undefined>
  /** Highest seq already read per channel, after the welcome has merged. */
  readState: Record<string, number>
  /** The channel on screen, when the app has focus; otherwise undefined. */
  focusedChannelId?: string | undefined
  /**
   * This person's alert settings, from a box that decides alerts. With them
   * the box's rules choose (docs/ALERTS.md): a muted channel stays quiet, a
   * channel set to All messages speaks up. Without them, the page's own:
   * DMs and mentions.
   */
  settings?: AlertSettings
}): MissedAlert | null {
  const wanted = input.missed.filter((m) => {
    if (!m.authorId || m.authorId === input.myId) return false
    if (m.seq <= (input.readState[m.channelId] ?? 0)) return false
    if (m.channelId === input.focusedChannelId) return false
    const channel = input.channels[m.channelId]
    if (input.settings && channel && input.myId) {
      return (
        messageAlertKind({
          message: { id: '', createdAt: 0, kind: 'text', ...m, authorId: m.authorId },
          channel: {
            id: m.channelId,
            name: channel.name ?? '',
            kind: channel.kind === 'dm' ? 'dm' : 'public',
            ...(channel.memberIds ? { memberIds: channel.memberIds } : {}),
          },
          person: { id: input.myId, name: input.myName ?? '' },
          level: levelFor(input.settings, m.channelId),
          readSeq: input.readState[m.channelId] ?? 0,
        }) !== null
      )
    }
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
    return { title: describe(first), body: first.body, count: 1, channelId: first.channelId }
  }

  // Several: say how many and who, because "3 messages" without a name is a
  // reason to open the app rather than an answer.
  const sources = [...new Set(wanted.map(describe))]
  const shown = sources.slice(0, 3).join(', ')
  const channels = new Set(wanted.map((m) => m.channelId))
  return {
    title: `${wanted.length} messages need you`,
    body: sources.length > 3 ? `${shown} and ${sources.length - 3} more` : shown,
    count: wanted.length,
    ...(channels.size === 1 ? { channelId: first.channelId } : {}),
  }
}
