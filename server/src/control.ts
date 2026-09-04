import { randomBytes, timingSafeEqual } from 'node:crypto'
import type * as Y from 'yjs'
import {
  agenda,
  nowMinutes,
  showDate,
  relative,
  toAgendaAct,
  type Act,
  type AgendaEntry,
} from '@crewbox/shared'

/**
 * The control surface: how a desk drives the box.
 *
 * A festival's production desk already has a Stream Deck running Bitfocus
 * Companion, and everything on it — vision, lighting, playback — is one
 * button away. Crewbox being the exception means crewbox is the thing
 * somebody has to remember to go and click, which on a show is the same as
 * the thing that doesn't happen.
 *
 * So: a small keyed HTTP surface, deliberately separate from the admin panel.
 * The admin panel is a person with a password doing something once; this is a
 * machine holding a key doing something a hundred times a night, and the two
 * want different credentials, different rate limits and different blast
 * radius. Nothing here can change the event, delete anything, or read a
 * message — it reads state and it raises tally.
 */

/** Header a caller may present the key in. Both are conventional; accept both. */
export const CONTROL_KEY_HEADER = 'x-api-key'

const SETTING_KEY = 'control:apiKey'

/** Pull a key out of request headers, whichever conventional form was used. */
export function keyFromHeaders(headers: Record<string, unknown>): string | null {
  const direct = headers[CONTROL_KEY_HEADER]
  if (typeof direct === 'string' && direct.trim()) return direct.trim()

  const auth = headers.authorization
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (match?.[1]) return match[1].trim()
  }
  return null
}

/**
 * Constant-time compare.
 *
 * The key is a bearer credential on a LAN anyone at the event is already on,
 * so a timing oracle is not the most likely attack — but a length-and-prefix
 * compare is free to get wrong and free to get right.
 */
export function keyMatches(presented: string | null, expected: string): boolean {
  if (!presented || !expected) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

interface SettingsStore {
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
}

/**
 * This box's control key: the configured one, or one it mints and remembers.
 *
 * An environment variable wins, and that is the recovery path — a box whose
 * stored key has leaked, or whose operator wants the same key across a spare,
 * can be started with one rather than being reconfigured.
 */
export function controlKey(store: SettingsStore, env = process.env): string {
  const configured = env.CREWBOX_CONTROL_KEY?.trim()
  if (configured) return configured

  const stored = store.getSetting(SETTING_KEY)
  if (stored) return stored

  const minted = randomBytes(24).toString('base64url')
  store.setSetting(SETTING_KEY, minted)
  return minted
}

/**
 * Who is on air.
 *
 * One person at a time, which is what a cut is: a vision mixer takes a camera
 * and everybody else is off it. Setting the same person twice is not an
 * event, and clearing is `null` rather than a separate call so a desk can
 * bind one button to "tally whoever this camera is on" and one to "clear".
 */
export class Tally {
  private userId: string | null = null
  private since = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns true when this actually changed something worth broadcasting. */
  set(userId: string | null): boolean {
    const next = userId?.trim() || null
    if (next === this.userId) return false
    this.userId = next
    this.since = next ? this.now() : 0
    return true
  }

  current(): { userId: string | null; since: number } {
    return { userId: this.userId, since: this.since }
  }

  /**
   * Forget a crew member who has gone.
   *
   * A tally left pointing at somebody who logged out an hour ago is a red
   * bar nobody can clear from the app, because the person it belongs to is
   * not there to see it.
   */
  forget(userId: string): boolean {
    if (this.userId !== userId) return false
    return this.set(null)
  }
}

/** Room name the shell's timetable lives in. Must match the web store. */
export const TIMETABLE_ROOM = 'timetable/event'

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * The running order, read off the document the box already relays.
 *
 * Defensive on every field, because this document is written by whatever
 * version of the app each phone happens to be running and read here by a
 * box that may be older or newer than all of them. A missing or wrong-typed
 * field reads as empty rather than throwing or defaulting to something a
 * desk might believe — an act with no time is a TBC slot, and the agenda
 * below declines to call a TBC slot "on now".
 *
 * Unnamed acts are kept rather than skipped. They are half-typed rows, and
 * they are on the phones' countdown too; dropping them here would make the
 * box say a stage is clear while the sidebar says something unnamed is on.
 */
export function readRunningOrder(doc: Y.Doc | null): Act[] {
  if (!doc) return []
  return doc
    .getArray<Y.Map<unknown>>('acts')
    .toArray()
    .map((entry) => ({
      id: text(entry.get('id')),
      name: text(entry.get('name')),
      stage: text(entry.get('stage')),
      date: text(entry.get('date')),
      start: text(entry.get('start')),
      end: text(entry.get('end')),
      changeover:
        typeof entry.get('changeover') === 'number' ? (entry.get('changeover') as number) : 0,
    }))
}

/**
 * One act on a desk's display: the numbers to do maths with, and the same
 * thing in words so a button can print it without doing any.
 */
export interface BoardEntry {
  name: string
  stage: string
  /** Minutes until it starts, negative once it has. Null when it is TBC. */
  startsIn: number | null
  endsIn: number | null
  /** "in 25 min" / "5 min ago" — empty when there is no time to render. */
  starts: string
  ends: string
}

export interface StageBoard {
  stage: string
  onNow: BoardEntry | null
  next: BoardEntry | null
}

/**
 * What is on and what is next, per stage, for a desk.
 *
 * The maths is the shell's, imported rather than reimplemented: the phones
 * and this endpoint answer "who is on" from the same code, including the
 * six-in-the-morning show-day roll that decides whether the 00:30 headliner
 * is the last act of tonight or the first of tomorrow. A box that disagreed
 * with the sidebar in a crew member's pocket would be worse than a box that
 * said nothing.
 *
 * `now` is passed in, so this is testable at any hour.
 */
export function stageBoard(acts: Act[], now: Date): StageBoard[] {
  const entry = (found: AgendaEntry | null): BoardEntry | null =>
    found && {
      name: found.act.name,
      stage: found.act.stage,
      startsIn: found.startsIn,
      endsIn: found.endsIn,
      starts: found.startsIn === null ? '' : relative(found.startsIn),
      ends: found.endsIn === null ? '' : relative(found.endsIn),
    }

  return agenda(acts.map(toAgendaAct), nowMinutes(now), showDate(now)).map((stage) => ({
    stage: stage.stage,
    onNow: entry(stage.onNow),
    next: entry(stage.next),
  }))
}
