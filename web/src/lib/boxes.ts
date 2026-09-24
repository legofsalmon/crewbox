import { getConfigAt } from './api.ts'
import { chatDatabase, chatDatabaseName } from './db.ts'
import { deleteLocalDatabase } from './docs/persistence.ts'
import { allDocStores } from './docs/store.ts'
import {
  eventIdFrom,
  eventPrefKeys,
  forgetEventRecord,
  isEventDatabase,
  openEvent,
  releaseEvent,
} from './eventScope.ts'
import { forgetPref } from './prefs.ts'
import { iphoneRefusesPlainHttp, isIosApp, normalizeOrigin } from './server.ts'
import { queuedIncidentsOf } from '../modules/incident/model/outbox.ts'
import { timetableDatabase } from '../shell/timetable/store.ts'

/**
 * An event's data on this device, taken as a whole: what the Boxes screen
 * shows for it, and what forgetting it deletes.
 *
 * Nothing here touches the open event's storage, which the page has open:
 * that one is left by signing out, and the Boxes screen offers Forget only
 * on the others.
 */

/** What this device holds for an event that exists nowhere else. */
export interface Holdings {
  /** Sheets, plots and screen maps, by this device's lists of them. */
  documents: number
  /** Messages written here that never reached the box. */
  unsentMessages: number
  /** Show-log entries written here that never reached the box. */
  unsentEntries: number
}

/** Every IndexedDB database this device has, or null where the browser will not say. */
export async function databaseNames(): Promise<string[] | null> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return null
  try {
    return (await indexedDB.databases()).flatMap((db) => (db.name ? [db.name] : []))
  } catch {
    return null
  }
}

/**
 * The messages waiting in an event's outbox.
 *
 * Asked of the database only if it is there, where the browser can say:
 * opening one that is not makes it, and looking at the Boxes screen should
 * not leave an empty chat cache behind for every event on it.
 */
async function unsentMessagesOf(event: string): Promise<number> {
  const names = await databaseNames()
  if (names && !names.includes(chatDatabaseName(event))) return 0
  const db = chatDatabase(event)
  try {
    return await db.outbox.count()
  } catch {
    return 0
  } finally {
    db.close()
  }
}

export async function holdingsOf(event: string): Promise<Holdings> {
  return {
    documents: allDocStores().reduce((sum, store) => sum + store.storageOf(event).ids().length, 0),
    unsentMessages: await unsentMessagesOf(event),
    unsentEntries: queuedIncidentsOf(event).length,
  }
}

function localStorageKeys(): string[] {
  try {
    return Object.keys(localStorage)
  } catch {
    return []
  }
}

/**
 * Delete everything this device holds for an event, and stop listing it.
 *
 * Its chat cache and outbox, its documents and their lists, the running
 * order, its queued show-log entries, its sign-in and its settings. Never the
 * open event's, whose storage this page has open.
 */
export async function forgetEvent(event: string): Promise<void> {
  if (event === openEvent()) throw new Error('The open event is left by signing out.')
  // Every name first: which names are an event's depends on whether it is
  // the first event, which releasing it below changes.
  const stores = allDocStores()
  const databases = new Set([chatDatabaseName(event), timetableDatabase(event)])
  const keys = new Set(eventPrefKeys(event, localStorageKeys()))
  for (const store of stores) {
    const storage = store.storageOf(event)
    databases.add(storage.indexDatabase)
    for (const id of storage.ids()) databases.add(storage.database(id))
    keys.add(storage.registryKey)
  }
  // A document whose list lost track of it is still the event's.
  for (const name of (await databaseNames()) ?? []) {
    if (isEventDatabase(name, event)) databases.add(name)
  }
  await Promise.all([...databases].map(deleteLocalDatabase))
  for (const key of keys) forgetPref(key)
  releaseEvent(event)
  forgetEventRecord(event)
}

/** What an address somebody typed turned out to be. */
export type FoundBox =
  | { kind: 'invalid'; message: string }
  | { kind: 'unreachable'; origin: string }
  | { kind: 'too-old'; origin: string }
  | { kind: 'event'; origin: string; id: string; name: string }

/**
 * Ask whatever is at a typed address which event it is running.
 *
 * Before anything of this device's goes there: the answer decides which of
 * its events, if any, the box belongs to.
 */
export async function findBox(
  input: string,
  fetchConfig: typeof getConfigAt = getConfigAt
): Promise<FoundBox> {
  const origin = normalizeOrigin(input)
  if (!origin) {
    return { kind: 'invalid', message: 'Type the box’s address, as the join poster shows it.' }
  }
  if (isIosApp() && iphoneRefusesPlainHttp(origin)) {
    return {
      kind: 'invalid',
      message:
        `An iPhone only connects to a name like ${new URL(origin).hostname} over HTTPS. ` +
        'Type https:// before it if the box has a certificate, or use the box’s IP address, like 192.168.8.1.',
    }
  }
  let config
  try {
    config = await fetchConfig(origin, AbortSignal.timeout(6000))
  } catch {
    return { kind: 'unreachable', origin }
  }
  const id = eventIdFrom(config.eventId)
  if (!id) return { kind: 'too-old', origin }
  return { kind: 'event', origin, id, name: config.eventName ?? '' }
}

/** When an event's box last let this device in, for its row. */
export function lastHere(seenAt: number, now: number): string {
  if (!seenAt) return ''
  const then = new Date(seenAt)
  const time = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const today = new Date(now)
  if (then.toDateString() === today.toDateString()) return `Last here today, ${time}`
  if (now - seenAt < 6 * 24 * 60 * 60_000) {
    return `Last here ${then.toLocaleDateString([], { weekday: 'short' })} ${time}`
  }
  return `Last here ${then.toLocaleDateString([], { day: 'numeric', month: 'short' })}`
}

export const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`

/** "a, b and c". */
export const list = (parts: string[]): string =>
  parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`

/**
 * What forgetting an event takes off this device, said before it does.
 *
 * Split by whether it can come back. The box keeps the chat and every
 * document for as long as it runs the event; what was never sent is on this
 * device and nowhere else.
 */
export function forgetCopy(holdings: Holdings): { gone: string; lost: string | null } {
  const kept = [
    ...(holdings.documents > 0 ? [plural(holdings.documents, 'document', 'documents')] : []),
    'its running order',
    'its chat',
    'your sign-in',
  ]
  const gone =
    `This device deletes what it keeps for it: ${list(kept)}. ` +
    'The box has its own copy of those, for as long as it runs this event.'
  const unsent = [
    ...(holdings.unsentMessages > 0
      ? [plural(holdings.unsentMessages, 'message', 'messages')]
      : []),
    ...(holdings.unsentEntries > 0
      ? [plural(holdings.unsentEntries, 'show-log entry', 'show-log entries')]
      : []),
  ]
  const lost = unsent.length
    ? `It also deletes ${list(unsent)} that never reached the box, and nothing else has a copy.`
    : null
  return { gone, lost }
}
