import type { OutboxEntry } from './db.ts'
import { eventIdFrom } from './eventScope.ts'
import type { RecordsPlugin } from './server.ts'
import type { QueuedIncident } from '../modules/incident/model/outbox.ts'

/**
 * Messages and show-log entries written on this device that its box hasn't
 * had yet, as the page holds them: in memory for as long as it is open, and
 * in the apps in files of the app's own as well (native RecordsPlugin), beside
 * each event's record (lib/appCopy.ts).
 *
 * Each queue is in the page's storage too, where it always was: messages in
 * the event's chat cache in IndexedDB (lib/db.ts), and show-log entries in
 * its localStorage (modules/incident/model/outbox.ts). That alone wasn't
 * enough, in two ways.
 *
 * - The page's storage can refuse a write: a full disk, or a browser set to
 *   block site data. The failure was swallowed, and the screen said the
 *   message or entry was held on the phone when it was held nowhere. The
 *   next reconnect read the queues and sent everything but it.
 * - In the apps the page's storage can be wiped without anyone asking, open
 *   page or not (lib/appCopy.ts), and every unsent message and entry went
 *   with it.
 *
 * So whatever reads a queue reads what is held here with it, and whatever
 * changes a queue changes this at the same moment: an item is held when it
 * is queued, and let go of when the box has it or refuses it, when it moves
 * to another event, and when the phone is handed on or the event forgotten.
 * One held here goes out at the next reconnect, whatever happened to the
 * page's storage, and in the apps one the app's files have goes out after
 * the next start as well. Each carries the ID its box files it under once
 * (server/src/store.ts), so one sent twice does no harm.
 *
 * A page can only tell the app's files are as it left them if it read them
 * at its start. One that couldn't writes nothing to them, and leaves what
 * they have for a start that can read it.
 */

/** Each kind of unsent work, as its queue keeps it. */
export interface Unsent {
  messages: OutboxEntry
  entries: QueuedIncident
}

export type UnsentKind = keyof Unsent

/** The slot each event's unsent messages are kept in, beside its record. It reaches phones. */
const MESSAGES_SLOT = 'outbox'

/** The slot each event's unsent show-log entries are kept in. It reaches phones. */
const ENTRIES_SLOT = 'incident-outbox'

const SLOTS: Readonly<Record<UnsentKind, string>> = {
  messages: MESSAGES_SLOT,
  entries: ENTRIES_SLOT,
}

/**
 * The longest a start waits for the app's files, as for its records
 * (lib/appCopy.ts): they answer in milliseconds, and this is for a bridge
 * that never does.
 */
const LOAD_WAIT_MS = 5000

type Held = { [K in UnsentKind]: Map<string, Unsent[K]> }

/**
 * By event ID, or '' on a device not told its event yet, whose work the page
 * holds but the app can't file.
 */
const held = new Map<string, Held>()

/** How many times each event's work has been let go of all at once (`clearedCount`). */
const cleared = new Map<string, number>()

/** What this page has let go of, by event and kind (`wasReleased`). */
const released = new Map<string, Set<string>>()

function releasedOf(event: string | null, kind: UnsentKind): Set<string> {
  const key = `${keyOf(event)}/${kind}`
  let ids = released.get(key)
  if (!ids) {
    ids = new Set()
    released.set(key, ids)
  }
  return ids
}

/** The app's files, once this page has read them at its start. Nothing is written to them until then. */
let files: RecordsPlugin | undefined

const keyOf = (event: string | null): string => event ?? ''

function heldOf(event: string | null): Held {
  let items = held.get(keyOf(event))
  if (!items) {
    items = { messages: new Map(), entries: new Map() }
    held.set(keyOf(event), items)
  }
  return items
}

/** An event's items of one kind that this page holds, in the order they were held. */
export function heldUnsent<K extends UnsentKind>(event: string | null, kind: K): Unsent[K][] {
  const items = held.get(keyOf(event))?.[kind]
  return items ? ([...items.values()] as Unsent[K][]) : []
}

/** Whether this page holds an item. */
export function holdsUnsent(event: string | null, kind: UnsentKind, clientMsgId: string): boolean {
  return held.get(keyOf(event))?.[kind].has(clientMsgId) ?? false
}

/**
 * Items from the page's storage, and after them any held here that it
 * lacks: what a queue has, read whole.
 */
export function withHeld<K extends UnsentKind>(
  stored: readonly Unsent[K][],
  event: string | null,
  kind: K
): Unsent[K][] {
  const ids = new Set(stored.map((item) => item.clientMsgId))
  return [...stored, ...heldUnsent(event, kind).filter((item) => !ids.has(item.clientMsgId))]
}

/**
 * Hold an item until the box has it, and have the app keep it. Settles to
 * whether the app's files have it: never anywhere but the apps, nor in an
 * app whose files this page couldn't read at its start.
 */
export function holdUnsent<K extends UnsentKind>(
  event: string | null,
  kind: K,
  item: Unsent[K]
): Promise<boolean> {
  ;(heldOf(event)[kind] as Map<string, Unsent[K]>).set(item.clientMsgId, item)
  releasedOf(event, kind).delete(item.clientMsgId)
  return save(event, kind)
}

/**
 * Let go of items: the box has them, or refused them, or they have gone to
 * another event. Settles once the app's files no longer have them, or
 * couldn't be told.
 */
export async function releaseUnsent(
  event: string | null,
  kind: UnsentKind,
  clientMsgIds: Iterable<string>
): Promise<void> {
  const items = held.get(keyOf(event))?.[kind]
  const gone = releasedOf(event, kind)
  let changed = false
  for (const id of clientMsgIds) {
    gone.add(id)
    changed = (items?.delete(id) ?? false) || changed
  }
  if (changed) await save(event, kind)
}

/**
 * Whether this page let go of an item since it last held it, so that
 * something that read a queue before it went doesn't hold it again
 * (lib/appCopy.ts): a message the box acknowledges while its chat cache is
 * being read, say.
 */
export function wasReleased(event: string | null, kind: UnsentKind, clientMsgId: string): boolean {
  return released.get(`${keyOf(event)}/${kind}`)?.has(clientMsgId) ?? false
}

/**
 * Let go of all of an event's items of the kinds given: a phone being handed
 * on, or an event forgotten. The app's files are told even if nothing was
 * held, in case a write that failed left something there.
 */
export async function releaseAllUnsent(
  event: string | null,
  kinds: readonly UnsentKind[] = ['messages', 'entries']
): Promise<void> {
  cleared.set(keyOf(event), clearedCount(event) + 1)
  const items = heldOf(event)
  for (const kind of kinds) items[kind].clear()
  await Promise.all(kinds.map((kind) => save(event, kind)))
}

/**
 * Changes whenever an event's work is let go of all at once, so that
 * something reading its queues meanwhile can tell not to keep what it read
 * (lib/appCopy.ts).
 */
export function clearedCount(event: string | null): number {
  return cleared.get(keyOf(event)) ?? 0
}

/** Settles once every write asked for so far is done: they go one at a time, in order. */
let writing: Promise<unknown> = Promise.resolve()

/** A write asked for and not yet begun, by event and kind: anything held meanwhile goes with it. */
const waiting = new Map<string, Promise<boolean>>()

/**
 * Write what is held of an event's kind to the app's files, whole, in place
 * of what was there: a slot with nothing in it is removed. Settles to whether
 * the write went through.
 */
function save(event: string | null, kind: UnsentKind): Promise<boolean> {
  const app = files
  const id = event === null ? undefined : eventIdFrom(event)
  if (!app || !id) return Promise.resolve(false)
  const key = `${id}/${kind}`
  const queued = waiting.get(key)
  if (queued) return queued
  const run = writing.then(async () => {
    waiting.delete(key)
    const items = heldUnsent(id, kind)
    try {
      if (items.length > 0) {
        await app.write({ event: id, slot: SLOTS[kind], value: JSON.stringify(items) })
      } else {
        await app.remove({ event: id, slot: SLOTS[kind] })
      }
      return true
    } catch {
      return false
    }
  })
  waiting.set(key, run)
  writing = run
  return run
}

/** What an item of each kind has to look like to be taken from the app's files. */
export type UnsentChecks = { [K in UnsentKind]: (value: unknown) => value is Unsent[K] }

function parse<T>(text: string, check: (value: unknown) => value is T): T[] {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) ? value.filter(check) : []
  } catch {
    return []
  }
}

/**
 * Read the app's files at the start, before anything reads a queue: from
 * then on whatever they have is held, and goes out with the rest. Settles to
 * whether they could be read, within a few seconds.
 */
export async function loadUnsent(app: RecordsPlugin, checks: UnsentChecks): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let read: { values?: Record<string, string> }[]
  try {
    read = await Promise.race([
      Promise.all([app.readAll({ slot: MESSAGES_SLOT }), app.readAll({ slot: ENTRIES_SLOT })]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('no answer')), LOAD_WAIT_MS)
      }),
    ])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
  const [messages, entries] = read.map((answer) => Object.entries(answer.values ?? {}))
  for (const [event, text] of messages ?? []) {
    if (!eventIdFrom(event) || typeof text !== 'string') continue
    for (const item of parse(text, checks.messages)) {
      heldOf(event).messages.set(item.clientMsgId, item)
    }
  }
  for (const [event, text] of entries ?? []) {
    if (!eventIdFrom(event) || typeof text !== 'string') continue
    for (const item of parse(text, checks.entries))
      heldOf(event).entries.set(item.clientMsgId, item)
  }
  files = app
  return true
}

/** Whether this page read the app's files at its start, and so keeps them in step. */
export function keepsUnsentInApp(): boolean {
  return files !== undefined
}
