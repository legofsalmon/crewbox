import Dexie, { type EntityTable } from 'dexie'
import type { Channel, Message, User } from '@crewbox/shared'

/** A send waiting for a server ack. Survives reloads and battery death. */
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

const db = new Dexie('crewbox') as Dexie & {
  messages: EntityTable<Message, 'id'>
  outbox: EntityTable<OutboxEntry, 'clientMsgId'>
  kv: EntityTable<Snapshot, 'key'>
}

db.version(1).stores({
  messages: 'id, [channelId+seq]',
  outbox: 'clientMsgId, createdAt',
  kv: 'key',
})

const KEEP_PER_CHANNEL = 300

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
    if (messages.length) await bestEffort(() => db.messages.bulkPut(messages))
  },

  loadMessages(): Promise<Message[]> {
    return orEmpty(() => db.messages.orderBy('[channelId+seq]').toArray(), [])
  },

  async clearChannel(channelId: string): Promise<void> {
    await bestEffort(() =>
      db.messages.where('[channelId+seq]').between([channelId, 0], [channelId, Infinity]).delete()
    )
  },

  async deleteMessages(ids: string[]): Promise<void> {
    if (ids.length) await bestEffort(() => db.messages.bulkDelete(ids))
  },

  /** Trim old messages so the cache doesn't grow without bound. */
  async prune(): Promise<void> {
    const all = await this.loadMessages()
    const byChannel = new Map<string, Message[]>()
    for (const m of all) {
      const list = byChannel.get(m.channelId) ?? []
      list.push(m)
      byChannel.set(m.channelId, list)
    }
    const stale: string[] = []
    for (const list of byChannel.values()) {
      if (list.length > KEEP_PER_CHANNEL) {
        for (const m of list.slice(0, list.length - KEEP_PER_CHANNEL)) stale.push(m.id)
      }
    }
    if (stale.length) await bestEffort(() => db.messages.bulkDelete(stale))
  },

  async putOutbox(entry: OutboxEntry): Promise<void> {
    await bestEffort(() => db.outbox.put(entry))
  },

  async deleteOutbox(clientMsgId: string): Promise<void> {
    await bestEffort(() => db.outbox.delete(clientMsgId))
  },

  loadOutbox(): Promise<OutboxEntry[]> {
    return orEmpty(() => db.outbox.orderBy('createdAt').toArray(), [])
  },

  async saveSnapshot(snapshot: Omit<Snapshot, 'key' | 'savedAt'>): Promise<void> {
    await bestEffort(() => db.kv.put({ key: 'snapshot', savedAt: Date.now(), ...snapshot }))
  },

  loadSnapshot(): Promise<Snapshot | undefined> {
    return orEmpty(() => db.kv.get('snapshot'), undefined)
  },

  /** Everything, for a device being handed to somebody else. */
  async wipe(): Promise<void> {
    await bestEffort(() => Promise.all([db.messages.clear(), db.outbox.clear(), db.kv.clear()]))
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
    await bestEffort(() => Promise.all([db.messages.clear(), db.kv.clear()]))
  },
}
