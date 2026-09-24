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
}

const isKnownEvent = (value: unknown): value is KnownEvent => {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<KnownEvent>
  return (
    typeof event.id === 'string' &&
    event.id !== '' &&
    typeof event.name === 'string' &&
    typeof event.origin === 'string' &&
    typeof event.seenAt === 'number'
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

/** Stop listing an event, and anything pointing at it. */
export function forgetEventRecord(id: string): void {
  writeKnown(
    knownEvents()
      .filter((event) => event.id !== id)
      .map((event) => {
        if (event.replacedBy !== id) return event
        const { replacedBy: _, moveAnswered: __, ...rest } = event
        return rest
      })
  )
}

/** For useSyncExternalStore: the list changes when a box is reached or forgotten. */
export function subscribeKnownEvents(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
