/**
 * What buzzes a phone: the rules, and the frames that carry the result.
 *
 * There used to be three copies of these rules and they disagreed. The page
 * decided in the browser, Android's service decided again in Java from the
 * raw chat protocol (and buzzed for every message in every channel, and for
 * "@Sammy" when you are Sam), and the iPhone had nothing at all while the app
 * was out of sight. So the rules live here, as pure functions, and the box
 * runs them for each person and sends each of their phones finished alerts:
 * who, where, what, how loud. A phone's native code posts what it is given
 * and never reads chat. The page's own socket gets the same alerts, so its
 * banner and chirp follow the same rules (docs/ALERTS.md).
 *
 * Deliberately pure, like the timetable maths: no clock, no store, no
 * socket. Everything a rule needs is passed in, so every rule is a row in a
 * table test, and the JVM tests read the same fixtures as the Node ones.
 */
import { z } from 'zod'
import { agenda, toAgendaAct, wallClock, type Act, type AgendaEntry } from './timetable.js'
import type { Incident } from './incident.js'

/**
 * The alerts contract's generation, sent in the box's first frame. A phone
 * that sees a newer one than it knows keeps going with what it understands:
 * every frame it doesn't know is skipped, never an error.
 */
export const ALERTS_VERSION = 1

/**
 * The path of the alerts socket, beside `/ws`. An older box drops the
 * upgrade, so a phone looks for `alerts` in `GET /api/config` first.
 */
export const ALERTS_PATH = '/ws/alerts'

/**
 * What every alerts-socket signature starts with.
 *
 * The same statement `GET /api/identity` signs (server/src/identity.ts): the
 * context, the event, the address the phone asked at, and the phone's
 * challenge. The alerts socket's first frame is an identity answer, so it
 * uses the identity context rather than one of its own, and the phones check
 * it with the code they already have.
 */
export const ALERTS_SIGNED_CONTEXT = 'crewbox-identity-v1'

/** How often the box sends a `beat`, unless the first frame says otherwise. */
export const BEAT_MS = 30_000

/** Missed beats before either end gives the socket up. */
export const BEATS_MISSED = 3

/** One sound per channel (or per thread of alerts) in this long. */
export const SOUND_GAP_MS = 30_000

/** How far back a catch-up reaches, and how much of it comes back. */
export const CATCH_UP_MS = 12 * 60 * 60_000
export const CATCH_UP_LIMIT = 20
/**
 * Changeover calls come back only from this recently. A call for a set that
 * has already started is noise, and a catch-up errs towards overlap anyway.
 */
export const CALL_CATCH_UP_MS = 2 * 60_000

/** A show-log entry alerts only when it was written down this soon after it happened. */
export const INCIDENT_ALERT_WINDOW_MS = 15 * 60_000

/** Minutes before a set's start that its "on in 5" call goes out. */
export const CALL_BEFORE_START_MIN = 5
/** How far ahead a moved set is worth a call. */
export const MOVED_WITHIN_MIN = 120

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * How much of a channel reaches somebody's pocket.
 *
 * `mentions` is where every channel starts, for everybody (Colly, 25
 * September): a DM, your name, `@channel` and the production desk. `all` is
 * what Android did for every channel before, kept for whoever wants it.
 * `muted` still lets your own name through, because somebody needs you in
 * particular.
 */
export const CHANNEL_ALERT_LEVELS = ['all', 'mentions', 'muted'] as const
export type ChannelAlertLevel = (typeof CHANNEL_ALERT_LEVELS)[number]
export const DEFAULT_CHANNEL_ALERTS: ChannelAlertLevel = 'mentions'

export const isChannelAlertLevel = (value: unknown): value is ChannelAlertLevel =>
  typeof value === 'string' && (CHANNEL_ALERT_LEVELS as readonly string[]).includes(value)

/** One person's alert settings, as the box keeps them and sends them. */
export interface AlertSettings {
  /** channelId → level, only where it differs from the default. */
  channels: Record<string, ChannelAlertLevel>
  /** Stage names this person follows, for changeover calls and the countdown. */
  stages: string[]
}

export const levelFor = (settings: AlertSettings, channelId: string): ChannelAlertLevel =>
  settings.channels[channelId] ?? DEFAULT_CHANNEL_ALERTS

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/**
 * What kind of alert, which decides how loud it is on each platform.
 *
 *  - `dm`, `mention`, `everyone`, `desk`: Android's "Mentions & DMs".
 *  - `message`: an ordinary message in a channel set to All messages.
 *  - `showStop`: a show stop or hold, just logged. Time Sensitive on an
 *    iPhone; the alarm stream on Android.
 *  - `changeover`: a changeover call for a followed stage. Time Sensitive,
 *    except a moved set, which is not.
 */
export const ALERT_KINDS = [
  'dm',
  'mention',
  'everyone',
  'desk',
  'message',
  'showStop',
  'changeover',
] as const
export type AlertKind = (typeof ALERT_KINDS)[number]

/** Where a tap on an alert takes somebody. */
export type AlertTarget =
  { kind: 'channel'; channelId: string } | { kind: 'showlog' } | { kind: 'stage'; stage: string }

export interface Alert {
  /**
   * Stable for the thing it is about: `m:<message id>`, `i:<entry id>`, or
   * `c:<act id>:<call>:<show day>:<start>`. A phone sent one twice replaces
   * the notification rather than adding another, so a catch-up can err
   * towards overlap and a box restarting mid-call costs nothing.
   */
  id: string
  kind: AlertKind
  title: string
  body: string
  target: AlertTarget
  /**
   * Groups a phone's notifications, and is what one sound per 30 seconds is
   * counted over: the channel for a message, `showlog`, or the stage.
   */
  thread: string
  /** Posted without sound: a catch-up's older alerts, a busy channel. */
  quiet: boolean
  /** Time Sensitive on an iPhone; its own loud channel on Android. */
  urgent: boolean
  /** When it happened, in the box's clock (ms). */
  at: number
  /** For a message: who sent it, so a phone can post it as a conversation. */
  from?: { id: string; name: string }
  /** For a message: its channel's position, so a `read` can take it back. */
  seq?: number
  /** For a message in a channel (not a DM): the channel's name, for grouping. */
  channelName?: string
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * True when the text @-mentions this person, or everyone.
 *
 * The page's test, moved here so the box, the page and the phones agree. A
 * name needs a boundary after it, so "@Sammy" doesn't mention Sam, and
 * "@allison" doesn't mention everyone. Android had neither boundary and
 * buzzed for both.
 */
export function isMentioned(body: string, myName: string | undefined): boolean {
  return mentionsEveryone(body) || mentionsName(body, myName)
}

/** `@all`, `@everyone` or `@channel`, as a word. */
export const mentionsEveryone = (body: string): boolean =>
  /@(all|everyone|channel)\b/.test(body.toLowerCase())

/** This person by name, with a boundary after it. */
export function mentionsName(body: string, myName: string | undefined): boolean {
  if (!myName) return false
  // Names can contain regex metacharacters ("Alex (Stage 2)"), so escape.
  const name = myName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@${name}(?![a-z0-9])`).test(body.toLowerCase())
}

/** As much of a message as the rules read. */
export interface AlertMessageInput {
  id: string
  channelId: string
  seq: number
  authorId: string | null
  kind: 'text' | 'system' | 'file'
  body: string
  file?: { name: string }
  /** `desk` for a message the production desk posted (Decision 5). */
  origin?: 'desk'
  createdAt: number
}

export interface AlertChannelInput {
  id: string
  name: string
  kind: 'public' | 'dm'
  retired?: boolean
  /** A DM's two members; absent for a public channel. */
  memberIds?: string[]
}

export interface AlertPerson {
  id: string
  name: string
}

/**
 * What a message is to one person, or null when it isn't for them at all.
 *
 * Nothing from a retired channel, nothing they have already read, nothing
 * they wrote, and no system message except the desk's. Then by their
 * setting for the channel:
 *
 *  - a DM alerts unless muted;
 *  - their own name alerts even when muted;
 *  - `@all`, `@everyone`, `@channel` and the desk alert unless muted;
 *  - anything else only in a channel set to All messages.
 */
export function messageAlertKind(input: {
  message: AlertMessageInput
  channel: AlertChannelInput
  person: AlertPerson
  level: ChannelAlertLevel
  /** Their read position in the channel. */
  readSeq: number
}): AlertKind | null {
  const { message, channel, person, level } = input
  if (channel.retired) return null
  if (message.seq <= input.readSeq) return null
  if (message.authorId === person.id) return null
  if (channel.kind === 'dm' && !(channel.memberIds ?? []).includes(person.id)) return null

  const desk = message.origin === 'desk'
  if (message.kind === 'system' && !desk) return null
  if (!desk && !message.authorId) return null

  const muted = level === 'muted'
  if (channel.kind === 'dm') return muted ? null : 'dm'
  if (mentionsName(message.body, person.name)) return 'mention'
  if (muted) return null
  if (desk) return 'desk'
  if (mentionsEveryone(message.body)) return 'everyone'
  return level === 'all' ? 'message' : null
}

/** A message's text for a notification: its body, or the file it carries. */
export const messageText = (message: AlertMessageInput): string =>
  message.body || (message.file ? `📎 ${message.file.name}` : '')

/**
 * A message as an alert. `authorName` is '' for the desk, which has none.
 * `quiet` is decided by the caller, which knows when this thread last sounded.
 */
export function messageAlert(input: {
  message: AlertMessageInput
  channel: AlertChannelInput
  kind: AlertKind
  authorName: string
  quiet: boolean
}): Alert {
  const { message, channel, kind } = input
  const dm = channel.kind === 'dm'
  const who = kind === 'desk' ? 'Production desk' : input.authorName || 'Someone'
  return {
    id: `m:${message.id}`,
    kind,
    title: dm ? who : `${who} in #${channel.name}`,
    body: messageText(message),
    target: { kind: 'channel', channelId: channel.id },
    thread: channel.id,
    quiet: input.quiet,
    urgent: false,
    at: message.createdAt,
    ...(kind === 'desk' || !message.authorId
      ? {}
      : { from: { id: message.authorId, name: input.authorName || 'Someone' } }),
    seq: message.seq,
    ...(dm ? {} : { channelName: channel.name }),
  }
}

// ---------------------------------------------------------------------------
// The show log
// ---------------------------------------------------------------------------

/**
 * Whether a show-log entry buzzes everyone (but its author).
 *
 * A show stop or a hold (Colly, 25 September), not a correction, and written
 * down within 15 minutes of when it happened: the log is written after the
 * fact, and an entry at 02:00 about a stop at 22:10 is history. Buzzing
 * every phone on site with "Show stop" at 02:00 would be alarming and wrong.
 */
export function incidentAlerts(incident: Incident): boolean {
  if (incident.kind !== 'show-stop' && incident.kind !== 'hold') return false
  if (incident.amends) return false
  return incident.loggedAt - incident.at <= INCIDENT_ALERT_WINDOW_MS
}

export function incidentAlert(incident: Incident, quiet: boolean): Alert {
  const what = incident.kind === 'hold' ? 'Hold' : 'Show stop'
  const where = incident.stage ? ` on ${incident.stage}` : ''
  return {
    id: `i:${incident.id}`,
    kind: 'showStop',
    title: `${what}${where}`,
    body: incident.authorName ? `${incident.authorName}: ${incident.body}` : incident.body,
    target: { kind: 'showlog' },
    thread: 'showlog',
    quiet,
    urgent: true,
    at: incident.loggedAt,
  }
}

// ---------------------------------------------------------------------------
// Changeover calls
// ---------------------------------------------------------------------------

/**
 * Which call: `changeover` as a set comes down with another to follow,
 * `soon` five minutes before a set, and `moved` when a set due within two
 * hours changes its start.
 */
export type CallKind = 'changeover' | 'soon' | 'moved'

/** A call due at a moment on the festival's clock. */
export interface ChangeoverCall {
  id: string
  call: CallKind
  stage: string
  actId: string
  actName: string
  /** Show day, YYYY-MM-DD, and the minutes into it that the call is due. */
  day: string
  due: number
  title: string
  body: string
  urgent: boolean
}

const hhmm = (showMinute: number): string => {
  const clock = ((showMinute % 1440) + 1440) % 1440
  return `${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}`
}

const callId = (actId: string, call: CallKind, day: string, start: number): string =>
  `c:${actId}:${call}:${day}:${start}`

/**
 * Every changeover and "on in 5" call a running order holds for one show
 * day, on the festival's clock.
 *
 * Stage by stage in running order, from the same agenda maths the phones'
 * sidebars use, so a call and the sidebar agree on who is next. A set that
 * moves re-arms its calls, because the start is in the id. A gap of zero
 * gets no changeover call (the next set is on as this one comes off), nor
 * does a set with no end time, which runs until the next starts.
 */
export function callsFor(acts: Act[], day: string): ChangeoverCall[] {
  const calls: ChangeoverCall[] = []
  const today = acts
    .map(toAgendaAct)
    .filter((act) => act.start !== null && (act.date === '' || act.date === day))
  const byStage = new Map<string, typeof today>()
  for (const act of today) {
    const stage = act.stage || 'Stage'
    byStage.set(stage, [...(byStage.get(stage) ?? []), act])
  }
  for (const [stage, list] of byStage) {
    const sorted = [...list].sort((a, b) => a.start! - b.start!)
    sorted.forEach((act, i) => {
      const start = act.start!
      const name = act.name || 'Next set'
      calls.push({
        id: callId(act.id, 'soon', day, start),
        call: 'soon',
        stage,
        actId: act.id,
        actName: name,
        day,
        due: start - CALL_BEFORE_START_MIN,
        title: `${name} on in ${CALL_BEFORE_START_MIN} min`,
        body: `${stage}, at ${hhmm(start)}`,
        urgent: true,
      })
      const before = sorted[i - 1]
      if (!before || before.end === null) return
      const gap = start - before.end
      if (gap <= 0) return
      calls.push({
        id: callId(act.id, 'changeover', day, start),
        call: 'changeover',
        stage,
        actId: act.id,
        actName: name,
        day,
        due: before.end,
        title: `Changeover on ${stage}`,
        body: `${name} on in ${gap} min`,
        urgent: true,
      })
    })
  }
  return calls
}

/**
 * Sets that moved between two readings of the running order, due within two
 * hours of `now`, as calls. `now` is minutes into `day` on the festival's
 * clock. Not Time Sensitive: nothing is happening yet. On an iPhone it is
 * also what prompts somebody to open the app so the Lock Screen countdown
 * catches up.
 */
export function movedCalls(
  before: Act[],
  after: Act[],
  day: string,
  now: number
): ChangeoverCall[] {
  const was = new Map(before.map(toAgendaAct).map((act) => [act.id, act] as const))
  const calls: ChangeoverCall[] = []
  for (const act of after.map(toAgendaAct)) {
    if (act.start === null || !act.id) continue
    if (act.date !== '' && act.date !== day) continue
    const old = was.get(act.id)
    if (!old || old.start === null || old.start === act.start) continue
    if (old.date !== act.date) continue
    // Due within two hours either before or after the move: a set pulled
    // forward into the window matters as much as one pushed back out of it.
    const within = (start: number) => start > now && start - now <= MOVED_WITHIN_MIN
    if (!within(old.start) && !within(act.start)) continue
    const stage = act.stage || 'Stage'
    const name = act.name || 'A set'
    calls.push({
      id: callId(act.id, 'moved', day, act.start),
      call: 'moved',
      stage,
      actId: act.id,
      actName: name,
      day,
      due: now,
      title: `${name} now on at ${hhmm(act.start)}`,
      body: `${stage}, was ${hhmm(old.start)}`,
      urgent: false,
    })
  }
  return calls
}

/** The calls due in (from, to], both minutes into `day` on the festival's clock. */
export const callsDue = (calls: ChangeoverCall[], from: number, to: number): ChangeoverCall[] =>
  calls.filter((call) => call.due > from && call.due <= to)

export function callAlert(call: ChangeoverCall, at: number, quiet: boolean): Alert {
  return {
    id: call.id,
    kind: 'changeover',
    title: call.title,
    body: call.body,
    target: { kind: 'stage', stage: call.stage },
    thread: `stage:${call.stage}`,
    quiet,
    urgent: call.urgent,
    at,
  }
}

// ---------------------------------------------------------------------------
// The countdown
// ---------------------------------------------------------------------------

/** One set on the lock-screen countdown, as instants a phone counts to. */
export interface CountdownSet {
  actId: string
  name: string
  /** Epoch ms, worked out in the phone's own time zone. */
  start: number
  /** Null when the running order gives no end and nothing follows. */
  end: number | null
}

export interface StageCountdown {
  stage: string
  onNow: CountdownSet | null
  next: CountdownSet | null
}

/**
 * The instant a wall-clock time in a zone falls on.
 *
 * `day` is a plain YYYY-MM-DD and `showMinute` the minutes into that show
 * day, so 00:30 is 1470. Worked through the zone's offset twice, which lands
 * on the right instant everywhere except inside a clock change's missing
 * hour, where it lands an hour on, as a phone's own clock would read it.
 * An unusable zone is the process zone, as `wallClock` has it.
 */
export function zonedInstant(day: string, showMinute: number, timeZone?: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return null
  const naive =
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + showMinute * 60_000
  let guess = naive - offsetAt(naive, timeZone)
  guess = naive - offsetAt(guess, timeZone)
  return guess
}

/** The zone's offset from UTC at an instant, in ms. */
function offsetAt(instant: number, timeZone?: string): number {
  const date = new Date(instant)
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(date)
      const value = (type: string) => Number(parts.find((p) => p.type === type)?.value)
      const asUtc = Date.UTC(
        value('year'),
        value('month') - 1,
        value('day'),
        value('hour'),
        value('minute'),
        value('second')
      )
      if (!Number.isNaN(asUtc)) return asUtc - Math.floor(instant / 1000) * 1000
    } catch {
      // Fall through to the process zone.
    }
  }
  return -date.getTimezoneOffset() * 60_000
}

/**
 * What is on and next on each followed stage, as instants for one phone.
 *
 * The phones' own agenda maths, read in the phone's own zone, so its lock
 * screen and its sidebar agree (Decision 7). The phone counts to these with
 * its own clock; the box's clock and the phone's are never compared.
 */
export function countdownFor(
  acts: Act[],
  stages: string[],
  now: Date,
  timeZone?: string
): StageCountdown[] {
  if (stages.length === 0) return []
  const clock = wallClock(now, timeZone)
  const wanted = new Set(stages)
  const set = (entry: AgendaEntry | null): CountdownSet | null => {
    if (!entry || entry.startsIn === null) return null
    const start = now.getTime() + entry.startsIn * 60_000
    return {
      actId: entry.act.id,
      name: entry.act.name,
      start: roundToMinute(start),
      end: entry.endsIn === null ? null : roundToMinute(now.getTime() + entry.endsIn * 60_000),
    }
  }
  return agenda(acts.map(toAgendaAct), clock.now, clock.today)
    .filter((stage) => wanted.has(stage.stage))
    .map((stage) => ({ stage: stage.stage, onNow: set(stage.onNow), next: set(stage.next) }))
}

/** Agenda maths counts whole minutes; the instants land on the minute they name. */
const roundToMinute = (ms: number): number => Math.floor(ms / 60_000) * 60_000

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * The box's first frame: who it is, signed over the phone's challenge.
 *
 * The phone opens `/ws/alerts?nonce=…` and checks this against the key it
 * kept for the event and the address it asked at before it sends its token,
 * so a box that took over the address, or anything else answering there,
 * never sees this event's sign-in. `signature` is absent when the box won't
 * sign for the address it was reached at (a port forward, a name over plain
 * HTTP); a phone that kept a key then goes no further.
 */
export interface AlertsBoxFrame {
  type: 'box'
  v: number
  eventId: string
  signature?: string
  /** How often the box will send `beat`. */
  beatMs: number
  /** The box's clock. */
  t: number
}

/** Phone → box, once the first frame checks out. */
export interface AlertsHelloFrame {
  type: 'hello'
  token: string
  /** When the phone last heard from this box, in the box's clock; null on a first connection. */
  since: number | null
  /** The phone's IANA time zone, for the countdown. */
  timeZone?: string
}

/** Box → phone, answering hello. */
export interface AlertsWelcomeFrame {
  type: 'welcome'
  t: number
  settings: AlertSettings
  /** What the phone missed since `since`, oldest first; every one quiet but the newest. */
  catchUp: Alert[]
  /** How many more there were than came back. */
  more: number
  stages: StageCountdown[]
}

export interface AlertsAlertFrame {
  type: 'alert'
  t: number
  alert: Alert
}

/** The person read a channel somewhere: take its alerts back up to `seq`. */
export interface AlertsReadFrame {
  type: 'read'
  t: number
  channelId: string
  seq: number
}

/** Alerts that are no longer true: a deleted message, a set that moved. */
export interface AlertsWithdrawFrame {
  type: 'withdraw'
  t: number
  ids: string[]
}

export interface AlertsSettingsFrame {
  type: 'settings'
  t: number
  settings: AlertSettings
}

export interface AlertsStagesFrame {
  type: 'stages'
  t: number
  stages: StageCountdown[]
}

/** Box → phone every `beatMs`; the phone answers with its own `beat`. */
export interface AlertsBeatFrame {
  type: 'beat'
  t: number
}

export type AlertsServerFrame =
  | AlertsBoxFrame
  | AlertsWelcomeFrame
  | AlertsAlertFrame
  | AlertsReadFrame
  | AlertsWithdrawFrame
  | AlertsSettingsFrame
  | AlertsStagesFrame
  | AlertsBeatFrame

/** What a phone may send, checked on the box. Anything else on the socket is ignored. */
export const alertsClientFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    token: z.string().min(1).max(512),
    since: z.number().int().nonnegative().nullable(),
    timeZone: z.string().max(64).optional(),
  }),
  z.object({ type: z.literal('beat'), t: z.number() }),
])

export type AlertsClientFrame = z.infer<typeof alertsClientFrameSchema>

// ---------------------------------------------------------------------------
// Catch-up
// ---------------------------------------------------------------------------

/**
 * A catch-up as it goes out: the newest `CATCH_UP_LIMIT`, oldest first, all
 * quiet but the newest, so a phone coming back to the Wi-Fi sounds once.
 *
 * Alerts from the same millisecond keep the order they are given in, which
 * for messages is the order the box stored them: two sent together would
 * otherwise be ordered by their random ids, and the older sound.
 */
export function shapeCatchUp(alerts: Alert[]): { catchUp: Alert[]; more: number } {
  const sorted = [...alerts].sort((a, b) => a.at - b.at)
  const kept = sorted.slice(-CATCH_UP_LIMIT)
  return {
    catchUp: kept.map((alert, i) => ({ ...alert, quiet: i !== kept.length - 1 })),
    more: sorted.length - kept.length,
  }
}
