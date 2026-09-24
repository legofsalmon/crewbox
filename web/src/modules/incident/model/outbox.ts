import { MAX_INCIDENT_LENGTH, type IncidentKind, type IncidentSeverity } from '@crewbox/shared'
import { storageName, storageNameFor } from '../../../lib/eventScope.ts'

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

const isQueued = (value: unknown): value is QueuedIncident => {
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
  return read(storageName(KEY))
}

/** What another event's queue holds, for moving it or forgetting the event. */
export function queuedIncidentsOf(event: string | null): QueuedIncident[] {
  return read(storageNameFor(event, KEY))
}

/** Empty another event's queue, once its entries are somewhere else. */
export function clearQueuedIncidentsOf(event: string | null): void {
  write([], storageNameFor(event, KEY))
}

function read(key: string): QueuedIncident[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isQueued) : []
  } catch {
    return []
  }
}

export function queueIncident(entry: QueuedIncident): void {
  const next = [...queuedIncidents().filter((e) => e.clientMsgId !== entry.clientMsgId), entry]
  write(next.slice(-MAX_QUEUED))
}

/** Called once the box has acknowledged the entry by broadcasting it back. */
export function unqueueIncident(clientMsgId: string): void {
  const next = queuedIncidents().filter((e) => e.clientMsgId !== clientMsgId)
  write(next)
}

/**
 * Forget everything queued, for a device being handed on.
 *
 * The queue outlived a logout, so the next person to pick the phone up filed
 * the last person's show-log entries — under their own name, into a permanent
 * record of what happened at an event. A session ending is different and does
 * not come through here: see `sessionEnded` in the store.
 */
export function clearQueuedIncidents(): void {
  write([])
}

function write(entries: QueuedIncident[], key = storageName(KEY)): void {
  try {
    localStorage.setItem(key, JSON.stringify(entries))
  } catch {
    // A full or blocked localStorage must not stop the entry going out over
    // the socket — the queue is the backstop, not the path.
  }
}
