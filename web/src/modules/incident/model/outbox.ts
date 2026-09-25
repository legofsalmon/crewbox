import { MAX_INCIDENT_LENGTH, type IncidentKind, type IncidentSeverity } from '@crewbox/shared'
import { openEvent, storageName, storageNameFor } from '../../../lib/eventScope.ts'
import { holdUnsent, releaseAllUnsent, releaseUnsent, withHeld } from '../../../lib/unsent.ts'

/**
 * Entries typed with no signal, kept until the box has them.
 *
 * Chat's outbox lives in IndexedDB and is shaped around channels; this is a
 * handful of rows at most, and it has one job the chat outbox does not: it
 * must survive a phone that gives up and reloads the app. localStorage is
 * synchronous, so an entry is on disk before the tap that filed it returns —
 * which is the property that matters when somebody logs a show stop and the
 * screen goes dark.
 *
 * The box dedupes on clientMsgId, so a flush that runs twice is harmless.
 *
 * One queue per event (see lib/eventScope.ts), because an entry belongs in
 * the log of the event it was written at: a queue that followed the phone
 * filed the last event's entries in the next one's log.
 *
 * The page holds each entry too, until the box has it, and in the apps so
 * does the app (lib/unsent.ts): localStorage can refuse the write, and in the
 * apps it can be wiped. Reading the queue reads both.
 */

const KEY = 'crewbox:incident-outbox'

/**
 * Enough for a bad night out of signal; past that the oldest goes. A phone
 * that has filed fifty unsent entries has a different problem, and filling
 * localStorage would take the session token with it.
 */
const MAX_QUEUED = 50

export interface QueuedIncident {
  clientMsgId: string
  kind: IncidentKind
  severity: IncidentSeverity
  body: string
  at: number
  stage: string
  actId: string
  actName: string
  amends?: string
}

/** Whether a value is a queued entry, as one read from storage or the app's files has to be. */
export function isQueuedIncident(value: unknown): value is QueuedIncident {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<QueuedIncident>
  return (
    typeof entry.clientMsgId === 'string' &&
    typeof entry.body === 'string' &&
    entry.body.length > 0 &&
    entry.body.length <= MAX_INCIDENT_LENGTH &&
    typeof entry.at === 'number'
  )
}

/** Everything still waiting. Junk in the slot reads as empty, never throws. */
export function queuedIncidents(): QueuedIncident[] {
  return queuedIncidentsOf(openEvent())
}

/** What another event's queue holds, for moving it or forgetting the event. */
export function queuedIncidentsOf(event: string | null): QueuedIncident[] {
  return withHeld(storedIncidentsOf(event), event, 'entries')
}

/** What an event's queue holds in localStorage, and nothing the page holds. */
export function storedIncidentsOf(event: string | null): QueuedIncident[] {
  return read(storageNameFor(event, KEY))
}

/** Take entries out of another event's queue, once they are somewhere else. */
export function unqueueIncidentsOf(event: string | null, clientMsgIds: ReadonlySet<string>): void {
  const key = storageNameFor(event, KEY)
  write(
    read(key).filter((e) => !clientMsgIds.has(e.clientMsgId)),
    key
  )
  void releaseUnsent(event, 'entries', clientMsgIds)
}

function read(key: string): QueuedIncident[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isQueuedIncident) : []
  } catch {
    return []
  }
}

/**
 * Queue an entry until the box has it: in localStorage before this returns,
 * and held (lib/unsent.ts). Settles to whether it was kept anywhere a reload
 * leaves it, localStorage or in the apps the app's files, so that an entry
 * kept nowhere can say so.
 */
export function queueIncident(entry: QueuedIncident): Promise<boolean> {
  const event = openEvent()
  const next = [
    ...queuedIncidentsOf(event).filter((e) => e.clientMsgId !== entry.clientMsgId),
    entry,
  ]
  const stored = write(next.slice(-MAX_QUEUED))
  // The oldest go past the limit, from what the page holds as from storage.
  void releaseUnsent(
    event,
    'entries',
    next.slice(0, -MAX_QUEUED).map((e) => e.clientMsgId)
  )
  return holdUnsent(event, 'entries', entry).then((kept) => stored || kept)
}

/** Called once the box has acknowledged the entry by broadcasting it back. */
export function unqueueIncident(clientMsgId: string): void {
  const key = storageName(KEY)
  write(
    read(key).filter((e) => e.clientMsgId !== clientMsgId),
    key
  )
  void releaseUnsent(openEvent(), 'entries', [clientMsgId])
}

/**
 * Forget everything queued, for a device being handed on.
 *
 * The queue outlived a logout, so the next person to pick the phone up filed
 * the last person's show-log entries — under their own name, into a permanent
 * record of what happened at an event. A session ending is different and does
 * not come through here: see `sessionEnded` in the store.
 */
export async function clearQueuedIncidents(): Promise<void> {
  write([])
  await releaseAllUnsent(openEvent(), ['entries'])
}

/** Whether localStorage took it. */
function write(entries: QueuedIncident[], key = storageName(KEY)): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(entries))
    return true
  } catch {
    // A full or blocked localStorage must not stop the entry going out over
    // the socket — the queue is the backstop, not the path.
    return false
  }
}
