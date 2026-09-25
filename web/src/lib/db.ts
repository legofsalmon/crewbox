import Dexie, { type EntityTable } from 'dexie'
import type { Channel, Message, User } from '@crewbox/shared'
import { openEvent, storageNameFor } from './eventScope.ts'
import { holdUnsent, releaseAllUnsent, releaseUnsent, withHeld } from './unsent.ts'

/**
 * A send waiting for a server ack. Survives reloads and battery death, and
 * is held while the page is open, and in the apps by the app (lib/unsent.ts).
 */
export interface OutboxEntry {
  clientMsgId: string
  channelId: string
  body: string
  createdAt: number
  /** Already-uploaded attachment, referenced on send. */
  fileId?: string
  fileName?: string
  fileMime?: string
}

const optionalText = (value: unknown): boolean => value === undefined || typeof value === 'string'

/** Whether a value is an outbox entry, as one read back from the app's files has to be. */
export function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<OutboxEntry>
  return (
    typeof entry.clientMsgId === 'string' &&
    entry.clientMsgId !== '' &&
    typeof entry.channelId === 'string' &&
    typeof entry.body === 'string' &&
    typeof entry.createdAt === 'number' &&
    optionalText(entry.fileId) &&
    optionalText(entry.fileName) &&
    optionalText(entry.fileMime)
  )
}

/** An outbox, with whatever the page holds (lib/unsent.ts) that it lacks, oldest first. */
const withHeldMessages = (stored: OutboxEntry[], event: string | null): OutboxEntry[] =>
  withHeld(stored, event, 'messages').sort((a, b) => a.createdAt - b.createdAt)

/** Sidebar/users snapshot so the app boots meaningfully with no network. */
export interface Snapshot {
  key: 'snapshot'
  me: User | null
  users: User[]
  channels: Channel[]
  readState: Record<string, number>
  /** Highest seq per channel that @-mentions me (absent in old snapshots). */
  mentionSeqs?: Record<string, number>
  savedAt: number
}

type CrewboxDb = Dexie & {
  messages: EntityTable<Message, 'id'>
  outbox: EntityTable<OutboxEntry, 'clientMsgId'>
  kv: EntityTable<Snapshot, 'key'>
}

/**
 * The chat cache is a database per event: this name for the first event a
 * device held, and one of the event's own for any other (see eventScope.ts).
 */
const DB_NAME = 'crewbox'

/** What an event's chat cache is called on this device. */
export const chatDatabaseName = (event: string | null): string => storageNameFor(event, DB_NAME)

/** An event's chat cache. Dexie opens it on the first thing asked of it. */
export function chatDatabase(event: string | null): CrewboxDb {
  const db = new Dexie(chatDatabaseName(event)) as CrewboxDb
  db.version(1).stores({
    messages: 'id, [channelId+seq]',
    outbox: 'clientMsgId, createdAt',
    kv: 'key',
  })
  return db
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
 * The messages waiting in an event's chat cache, and nothing the page holds.
 *
 * Asked of the database only if it is there, where the browser can say:
 * opening one that is not makes it, and a look at an event's work should
 * not leave an empty chat cache behind.
 */
export async function storedOutboxOf(event: string): Promise<OutboxEntry[]> {
  const names = await databaseNames()
  if (names && !names.includes(chatDatabaseName(event))) return []
  const db = chatDatabase(event)
  try {
    return await db.outbox.orderBy('createdAt').toArray()
  } catch {
    return []
  } finally {
    db.close()
  }
}

/** Every message waiting to go to an event's box: in its chat cache, and held (lib/unsent.ts). */
export async function outboxOf(event: string): Promise<OutboxEntry[]> {
  return withHeldMessages(await storedOutboxOf(event), event)
}

let open: CrewboxDb | null = null

/**
 * The open event's, made on first use rather than when this module loads, so
 * that it is the open event's and not whichever was open when it loaded.
 */
const database = (): CrewboxDb => (open ??= chatDatabase(openEvent()))

const KEEP_PER_CHANNEL = 300

/**
 * How often a prune is worth doing.
 *
 * It runs on every welcome, and a welcome is not a rare event: a phone at
 * the edge of an access point reconnects every few seconds. Three hundred
 * messages per channel is a cap, not a quota — being a few over it for a few
 * minutes costs nothing, and pruning on every reconnect costs the device
 * that can least afford it.
 */
const PRUNE_EVERY_MS = 5 * 60_000
let lastPrune = 0

/**
 * Nothing in here rejects.
 *
 * IndexedDB can refuse to open at all — a corrupted Chrome profile, a private
 * window, a browser set to block site data, a quota that has run out — and it
 * refuses by rejecting the first thing you ask it. Every caller in this app
 * is one of two kinds, and both are wrong to be given a rejection:
 *
 *  - **Boot awaits it.** `boot()` loaded the snapshot, the messages and the
 *    outbox with `Promise.all` and no catch, and `App.tsx` calls `boot()`
 *    with `void`, so a rejection left `phase` on its initial value for ever:
 *    no join form, no socket, no message, on the one screen with nothing on
 *    it to explain itself.
 *  - **Others gate a "loaded" flag on it** — the docs store's `whenLoaded`,
 *    the timetable store's `loaded` — which then never settles, and a pane
 *    waits for a promise that has already failed.
 *
 * A contract of "the caller remembers to catch" has now failed in three
 * separate places, so the contract is wrong. This is a cache: everything in
 * it arrives again from the box, so having none of it costs a moment of
 * blankness and nothing else. Reads answer as if empty, writes do nothing,
 * and the app carries on and reconciles from the welcome.
 */
const orEmpty = <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return work().catch(() => fallback)
  } catch {
    // Dexie can throw synchronously when the database failed to open.
    return Promise.resolve(fallback)
  }
}

/** A write worth doing and never worth failing over. */
const bestEffort = (work: () => Promise<unknown>): Promise<void> =>
  orEmpty(() => work().then(() => undefined), undefined)

export const cache = {
  async saveMessages(messages: Message[]): Promise<void> {
    if (messages.length) await bestEffort(() => database().messages.bulkPut(messages))
  },

  loadMessages(): Promise<Message[]> {
    return orEmpty(() => database().messages.orderBy('[channelId+seq]').toArray(), [])
  },

  /**
   * A page of one channel's history, older than `before`.
   *
   * What `loadOlder` should ask before it asks the box. Scrolling back
   * through a channel went straight to the network even when the rows were
   * already on this phone — which on a festival network is the difference
   * between instant and never. Offline is the default here; the cache is not
   * only a boot accelerator.
   */
  loadOlderInChannel(channelId: string, before: number, limit: number): Promise<Message[]> {
    return orEmpty(
      () =>
        database()
          .messages.where('[channelId+seq]')
          .between([channelId, 0], [channelId, before], true, false)
          .reverse()
          .limit(limit)
          .toArray()
          .then((rows) => rows.reverse()),
      []
    )
  },

  async clearChannel(channelId: string): Promise<void> {
    await bestEffort(() =>
      database()
        .messages.where('[channelId+seq]')
        .between([channelId, 0], [channelId, Infinity])
        .delete()
    )
  },

  async deleteMessages(ids: string[]): Promise<void> {
    if (ids.length) await bestEffort(() => database().messages.bulkDelete(ids))
  },

  /**
   * Trim old messages so the cache doesn't grow without bound.
   *
   * Per channel, over the compound index, reading keys rather than rows.
   * This used to load *every cached message on the device* — bodies and all,
   * up to three hundred per channel across every channel a crew member is
   * in — build a Map of them and throw the whole thing away. On a welcome.
   * A phone flapping at the edge of an AP does a welcome every ten seconds,
   * and that is the phone least able to afford it.
   *
   * `channelIds` because the caller knows them and the index does not offer
   * a distinct-values scan worth having; a channel absent from the list is
   * simply not pruned this pass, which the next one fixes.
   */
  async prune(channelIds: string[]): Promise<void> {
    const now = Date.now()
    if (now - lastPrune < PRUNE_EVERY_MS) return
    lastPrune = now
    for (const channelId of channelIds) {
      await bestEffort(async () => {
        const range = database()
          .messages.where('[channelId+seq]')
          .between([channelId, 0], [channelId, Infinity])
        const held = await range.count()
        if (held <= KEEP_PER_CHANNEL) return
        // The index is ordered by seq within the channel, so the first
        // `excess` keys are the oldest — which is what a cap means here.
        const stale = await range.limit(held - KEEP_PER_CHANNEL).primaryKeys()
        if (stale.length) await database().messages.bulkDelete(stale)
      })
    }
  },

  /**
   * Queue a message until the box has it: in the chat cache, and held
   * (lib/unsent.ts). Settles to whether it was kept anywhere a reload
   * leaves it, the chat cache or in the apps the app's files, so that a
   * message kept nowhere can say so.
   */
  async putOutbox(entry: OutboxEntry): Promise<boolean> {
    const [stored, kept] = await Promise.all([
      orEmpty(
        () =>
          database()
            .outbox.put(entry)
            .then(() => true),
        false
      ),
      holdUnsent(openEvent(), 'messages', entry),
    ])
    return stored || kept
  },

  async deleteOutbox(clientMsgId: string): Promise<void> {
    await Promise.all([
      bestEffort(() => database().outbox.delete(clientMsgId)),
      releaseUnsent(openEvent(), 'messages', [clientMsgId]),
    ])
  },

  /** Every message waiting to go, oldest first: in the chat cache, and held. */
  async loadOutbox(): Promise<OutboxEntry[]> {
    const stored = await orEmpty(() => database().outbox.orderBy('createdAt').toArray(), [])
    return withHeldMessages(stored, openEvent())
  },

  async saveSnapshot(snapshot: Omit<Snapshot, 'key' | 'savedAt'>): Promise<void> {
    await bestEffort(() => database().kv.put({ key: 'snapshot', savedAt: Date.now(), ...snapshot }))
  },

  loadSnapshot(): Promise<Snapshot | undefined> {
    return orEmpty(() => database().kv.get('snapshot'), undefined)
  },

  /** Everything, for a device being handed to somebody else. */
  async wipe(): Promise<void> {
    await Promise.all([
      bestEffort(() =>
        Promise.all([database().messages.clear(), database().outbox.clear(), database().kv.clear()])
      ),
      releaseAllUnsent(openEvent(), ['messages']),
    ])
  },

  /**
   * Everything except what has not been sent yet.
   *
   * For a session the box has rejected: the token is finished, but the
   * messages this crew member typed and could not deliver are still theirs,
   * on their own phone, and they are about to sign in again as themselves.
   * Wiping those was throwing away work because a credential expired.
   */
  async wipeExceptOutbox(): Promise<void> {
    await bestEffort(() => Promise.all([database().messages.clear(), database().kv.clear()]))
  },
}
