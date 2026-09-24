import { forgetPref, readPref, writePref } from './prefs.ts'

/**
 * Which event this device's storage belongs to, so that two boxes never
 * share it.
 *
 * The app talks to every box from one origin, and everything it keeps was
 * named after the module alone: `crewbox-patch-sheet-<id>`, `crewbox:token`,
 * the `crewbox` chat cache. So a phone that went from one event to the next
 * carried the first event's sheets and running order into the second box,
 * where that crew found them; a stray the second crew deleted took the
 * deletion back to the first event, where it may have been the last copy;
 * and show-log entries still queued for one event were filed in the next
 * one's log. A browser had the same problem wherever two boxes had used one
 * address.
 *
 * Every box database carries an ID for life — the server's `dbEpoch`, which
 * a restored backup keeps and a spare box with a fresh database does not.
 * That ID is the event, and each event's data is kept under names of its own.
 *
 * Except one. Storage names reach phones in the field (CLAUDE.md), and a
 * phone updated in the middle of an event must open exactly what it had. So
 * the event a device already holds keeps today's names, and only the events
 * after it get new ones:
 *
 *   the first event   crewbox:token          crewbox          crewbox-patch-sheet-<id>
 *   any other         crewbox@<id>:token     crewbox@<id>     crewbox@<id>-patch-sheet-<id>
 *
 * Which event has today's names is `crewbox:db-epoch`: phones have written
 * the ID of the database their cache came from there on every welcome, so an
 * updated phone already names the event it holds. A device with none gives
 * today's names to the first event it is told of, so a phone that only ever
 * sees one box stores everything exactly where it always did.
 *
 * The open event is fixed for the life of the page. Opening another one
 * reloads, because every store in the app opens its storage once and keeps
 * it: a chat cache or a document read from one event and written to another
 * is the thing this exists to prevent.
 */

/**
 * The event whose data is kept under today's names.
 *
 * Reaches real devices: every phone in the field has it, naming the database
 * its cache came from. Renaming it would give an updated phone's own event
 * new names, and it would open empty.
 */
const FIRST_EVENT_KEY = 'crewbox:db-epoch'

/** The event this device opens, once there has been more than one. */
const OPEN_EVENT_KEY = 'crewbox:event'

/** Every event this device holds anything for (see `KnownEvent`). */
const KNOWN_EVENTS_KEY = 'crewbox:boxes'

/** The prefix every storage name in the app starts with. */
const PREFIX = 'crewbox'

/**
 * The first event's small settings, by today's names, apart from its lists
 * of documents (each module's store knows its own). Forgetting the first
 * event deletes these; every other `crewbox:` key is the device's.
 * storagenames.test.ts fails on a key that is neither.
 */
export const EVENT_PREF_KEYS: readonly string[] = [
  'crewbox:token',
  'crewbox:event-name',
  'crewbox:wifi-ssid',
  'crewbox:modules',
  'crewbox:patch-seen',
  'crewbox:lighting-seen',
  'crewbox:video-screens-seen',
  'crewbox:incident-outbox',
  'crewbox:incident-stage',
]

/** The device's own settings, whichever event is open. Never an event's to delete. */
export const DEVICE_PREF_KEYS: readonly string[] = [
  'crewbox:audio-in',
  'crewbox:audio-out',
  KNOWN_EVENTS_KEY,
  FIRST_EVENT_KEY,
  OPEN_EVENT_KEY,
  'crewbox:find-boxes-asked',
  'crewbox:ios-tip-dismissed',
  // Reports somebody pressed Send on, for the studio, handed to whichever box
  // the app is next online with (lib/reports.ts). Not the event's to delete.
  'crewbox:report-outbox',
  'crewbox:server-url',
  'crewbox:sounds',
  'crewbox:theme',
]

/**
 * An event ID as a box sends it, if it is one this device can file data under.
 *
 * A box mints it with newId: letters and digits. Anything else is taken as no
 * ID at all, which is how the app has always taken a box. The characters
 * matter, because the ID goes into storage names: a `-` or `:` in it would
 * make one event's names look like the start of another's.
 */
export function eventIdFrom(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9A-Za-z_]{1,64}$/.test(value) ? value : undefined
}

let opened: string | null | undefined

/**
 * The event whose data this page has open, or null on a device that has not
 * been told one yet: a new phone, or one whose data came from a box too old
 * to say.
 */
export function openEvent(): string | null {
  if (opened === undefined) opened = readPref(OPEN_EVENT_KEY) ?? readPref(FIRST_EVENT_KEY)
  return opened
}

/** Whether this event's data is under today's names. */
function hasTodaysNames(event: string | null): boolean {
  return event === null || event === readPref(FIRST_EVENT_KEY)
}

/**
 * What one of today's storage names is called for an event's data.
 *
 * `name` is the name as the app has always used it, and every one of those
 * starts `crewbox`: a localStorage key, an IndexedDB database, or the start
 * of one. The first event's is unchanged; any other's gets the event after
 * that prefix, where no name of today's can have it.
 */
export function storageNameFor(event: string | null, name: string): string {
  if (hasTodaysNames(event)) return name
  return `${PREFIX}@${event}${name.slice(PREFIX.length)}`
}

/** What one of today's storage names is called for the open event's data. */
export function storageName(name: string): string {
  return storageNameFor(openEvent(), name)
}

/** The start every storage name of this event's has, for finding them all. */
export function storagePrefixFor(event: string): string | null {
  return hasTodaysNames(event) ? null : `${PREFIX}@${event}`
}

/**
 * Whether an IndexedDB database is one of this event's.
 *
 * Every database the app makes belongs to an event: the chat cache and each
 * document, the running order among them. So the first event's are all of
 * today's, `crewbox` and `crewbox-…`, and any other's are the same under its
 * own prefix. An event ID has no `-` in it, so one event's never match
 * another's.
 */
export function isEventDatabase(name: string, event: string): boolean {
  const prefix = storagePrefixFor(event) ?? PREFIX
  return name === prefix || name.startsWith(`${prefix}-`)
}

/**
 * This event's small settings among the localStorage keys given, apart from
 * the first event's lists of documents, which each module's store names.
 *
 * Any event but the first has every key under its own prefix. The first
 * event's share today's names with the device's own settings, so they are
 * the ones listed as an event's, and never a key of the device's.
 */
export function eventPrefKeys(event: string, keys: Iterable<string>): string[] {
  const prefix = storagePrefixFor(event)
  const all = [...keys]
  if (prefix === null) return all.filter((key) => EVENT_PREF_KEYS.includes(key))
  return all.filter(
    (key) => key === prefix || key.startsWith(`${prefix}:`) || key.startsWith(`${prefix}-`)
  )
}

/** A small setting of the open event's. */
export const readEventPref = (key: string): string | null => readPref(storageName(key))
export const writeEventPref = (key: string, value: string): void =>
  writePref(storageName(key), value)
export const forgetEventPref = (key: string): void => forgetPref(storageName(key))

/**
 * A box has said which event it is running. Is that the one this page has
 * open?
 *
 * On a device that has not been told an event yet, it becomes the open one,
 * with today's names, which are the names this page already has open. A box
 * that says nothing predates event IDs, and is taken as it always was.
 */
export function acceptEvent(event: string | undefined): boolean {
  if (!event) return true
  const open = openEvent()
  if (open === event) return true
  if (open !== null) return false
  writePref(FIRST_EVENT_KEY, event)
  writePref(OPEN_EVENT_KEY, event)
  opened = event
  return true
}

/**
 * Open another event's data from the next load of the page on.
 *
 * The caller reloads. Until it does, this page goes on with what it has
 * open, so nothing of one event's is written into the other's.
 */
export function chooseEvent(event: string): void {
  // Settle this page's own first, in case nothing has asked yet.
  openEvent()
  writePref(OPEN_EVENT_KEY, event)
}

/**
 * Give up an event's claim to today's names, once its data has gone.
 *
 * Only the first event has them, and a device keeps them empty from then on
 * unless it is back to having no event at all.
 */
export function releaseEvent(event: string): void {
  if (readPref(FIRST_EVENT_KEY) === event) forgetPref(FIRST_EVENT_KEY)
  if (readPref(OPEN_EVENT_KEY) === event) forgetPref(OPEN_EVENT_KEY)
}

/** An event this device holds data for, as the Boxes screen lists it. */
export interface KnownEvent {
  /** The box database's ID. */
  id: string
  /** The event's name when its box was last reached; '' if it has none. */
  name: string
  /** The address it was last reached at, as an origin (`http://10.0.0.2`). */
  origin: string
  /** When its box last let this device in (ms); 0 if never since this list existed. */
  seenAt: number
  /**
   * An event found at this one's address since: its box came back with a
   * new database. This device's work for it can be moved there.
   */
  replacedBy?: string
  /** The offer to move this event's work across has been answered. */
  moveAnswered?: boolean
  /**
   * The event whose box says it carries this one on, as its admin told it
   * to (Admin → This box): a spare with no backup, or a bigger box. Kept
   * once this device has heard it from that box, so the offer to move the
   * work across is made once for each box that says so.
   */
  continuedBy?: string
  /**
   * The event's public key, kept from the first box that let this device
   * in for it and never replaced by a box's say-so: what a box at another
   * address has to sign with to be followed there (lib/identity.ts).
   */
  key?: string
}

const isKnownEvent = (value: unknown): value is KnownEvent => {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<KnownEvent>
  return (
    typeof event.id === 'string' &&
    event.id !== '' &&
    typeof event.name === 'string' &&
    typeof event.origin === 'string' &&
    typeof event.seenAt === 'number' &&
    (event.key === undefined || typeof event.key === 'string')
  )
}

let knownCache: KnownEvent[] | null = null
const listeners = new Set<() => void>()

/** Every event this device holds data for. Junk in the slot reads as none. */
export function knownEvents(): KnownEvent[] {
  if (knownCache) return knownCache
  try {
    const parsed: unknown = JSON.parse(readPref(KNOWN_EVENTS_KEY) ?? '[]')
    knownCache = Array.isArray(parsed) ? parsed.filter(isKnownEvent) : []
  } catch {
    knownCache = []
  }
  return knownCache
}

export function knownEvent(id: string): KnownEvent | undefined {
  return knownEvents().find((event) => event.id === id)
}

function writeKnown(events: KnownEvent[]): void {
  knownCache = events
  writePref(KNOWN_EVENTS_KEY, JSON.stringify(events))
  for (const listener of listeners) listener()
}

/** Record what is known of an event, keeping whatever this does not say. */
export function rememberEvent(update: Partial<KnownEvent> & { id: string }): void {
  const events = knownEvents()
  const before = events.find((event) => event.id === update.id)
  const next: KnownEvent = { name: '', origin: '', seenAt: 0, ...before, ...update }
  if (before && JSON.stringify(before) === JSON.stringify(next)) return
  writeKnown([...events.filter((event) => event.id !== update.id), next])
}

/**
 * An event's box has proven itself at another address (lib/identity.ts): the
 * event is there now.
 *
 * Whatever took its old address did not take its place, so nothing of its
 * work is offered to that one any more; it goes to its own box, where it is.
 */
export function eventMoved(id: string, origin: string): void {
  const event = knownEvent(id)
  if (!event) return
  const { replacedBy: _, moveAnswered: __, ...rest } = event
  const next: KnownEvent = { ...rest, origin }
  if (JSON.stringify(next) === JSON.stringify(event)) return
  writeKnown([...knownEvents().filter((known) => known.id !== id), next])
}

/**
 * The open event's box says it carries this event on: its admin said so
 * (server/src/continues.ts). The work this device holds for it can go there,
 * and is offered once, unless this box has said so before.
 *
 * The admin's word, not a proof, which only this event's own box could give.
 * So it is only ever asked about, of a crew member who has joined that box.
 */
export function carriedOn(id: string, by: string): void {
  const event = knownEvent(id)
  if (!event || id === by || event.continuedBy === by) return
  const { moveAnswered: _, ...rest } = event
  writeKnown([
    ...knownEvents().filter((known) => known.id !== id),
    { ...rest, replacedBy: by, continuedBy: by },
  ])
}

/**
 * Keep an event's public key, if this device has none for it yet.
 *
 * Only ever the first: a box offering another key for an event this device
 * holds is the thing the key is there to catch. The one way to replace it is
 * somebody opening a box that failed the check anyway (`rememberEvent`).
 */
export function keepEventKey(id: string, key: string | undefined): void {
  const event = knownEvent(id)
  if (key && event && !event.key) rememberEvent({ id, key })
}

/**
 * The offer to bring an event's work to the event that took its place has
 * been answered.
 *
 * `settled` once nothing is left that a later move could still bring: then
 * the two events have nothing more to do with each other. Otherwise the
 * question is not asked again, and the event's row goes on offering it.
 */
export function answerMove(id: string, settled: boolean): void {
  const event = knownEvent(id)
  if (!event) return
  if (!settled) {
    rememberEvent({ id, moveAnswered: true })
    return
  }
  const { replacedBy: _, moveAnswered: __, ...rest } = event
  writeKnown([...knownEvents().filter((known) => known.id !== id), rest])
}

/** Stop listing an event, and anything pointing at it. */
export function forgetEventRecord(id: string): void {
  writeKnown(
    knownEvents()
      .filter((event) => event.id !== id)
      .map((event) => {
        if (event.replacedBy !== id && event.continuedBy !== id) return event
        const next = { ...event }
        if (next.replacedBy === id) {
          delete next.replacedBy
          delete next.moveAnswered
        }
        if (next.continuedBy === id) delete next.continuedBy
        return next
      })
  )
}

/** For useSyncExternalStore: the list changes when a box is reached or forgotten. */
export function subscribeKnownEvents(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
