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

export const cache = {
  async saveMessages(messages: Message[]): Promise<void> {
    if (messages.length) await db.messages.bulkPut(messages)
  },

  async loadMessages(): Promise<Message[]> {
    return db.messages.orderBy('[channelId+seq]').toArray()
  },

  async clearChannel(channelId: string): Promise<void> {
    await db.messages
      .where('[channelId+seq]')
      .between([channelId, 0], [channelId, Infinity])
      .delete()
  },

  async deleteMessages(ids: string[]): Promise<void> {
    if (ids.length) await db.messages.bulkDelete(ids)
  },

  /** Trim old messages so the cache doesn't grow without bound. */
  async prune(): Promise<void> {
    const all = await db.messages.orderBy('[channelId+seq]').toArray()
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
    if (stale.length) await db.messages.bulkDelete(stale)
  },

  async putOutbox(entry: OutboxEntry): Promise<void> {
    await db.outbox.put(entry)
  },

  async deleteOutbox(clientMsgId: string): Promise<void> {
    await db.outbox.delete(clientMsgId)
  },

  async loadOutbox(): Promise<OutboxEntry[]> {
    return db.outbox.orderBy('createdAt').toArray()
  },

  async saveSnapshot(snapshot: Omit<Snapshot, 'key' | 'savedAt'>): Promise<void> {
    await db.kv.put({ key: 'snapshot', savedAt: Date.now(), ...snapshot })
  },

  async loadSnapshot(): Promise<Snapshot | undefined> {
    return db.kv.get('snapshot')
  },

  async wipe(): Promise<void> {
    await Promise.all([db.messages.clear(), db.outbox.clear(), db.kv.clear()])
  },
}
