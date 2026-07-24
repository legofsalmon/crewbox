import type { DatabaseSync } from 'node:sqlite'
import { unlinkSync } from 'node:fs'
import { newId } from '@inter/shared'
import type {
  Channel,
  ChannelKind,
  FileMeta,
  Message,
  MessageKind,
  Role,
  User,
} from '@inter/shared'
import { transaction } from './db.ts'

interface UserRow {
  id: string
  name: string
  role: string
  pin_hash: string
  created_at: number
}

interface ChannelRow {
  id: string
  name: string
  kind: string
  topic: string
  retired: number
  created_at: number
  last_seq: number
}

interface MessageRow {
  id: string
  channel_id: string
  seq: number
  author_id: string | null
  kind: string
  body: string
  client_msg_id: string | null
  created_at: number
  file_id: string | null
  file_name: string | null
  file_mime: string | null
  file_size: number | null
  file_width: number | null
  file_height: number | null
  file_thumb: string | null
}

/** messages joined with their file attachment, aliased for toMessage. */
const MSG_SELECT = `
  SELECT m.*, f.name AS file_name, f.mime AS file_mime, f.size AS file_size,
         f.width AS file_width, f.height AS file_height, f.thumb_path AS file_thumb
  FROM messages m LEFT JOIN files f ON f.id = m.file_id
`

/** A row of the `files` table. */
interface FileRow {
  id: string
  name: string
  mime: string
  size: number
  path: string
  width: number | null
  height: number | null
  thumb_path: string | null
}

/** The single place that maps raw file columns to the wire FileMeta shape. */
function toFileMeta(f: {
  id: string
  name: string
  mime: string | null
  size: number | null
  width: number | null
  height: number | null
  thumb: string | null
}): FileMeta {
  return {
    id: f.id,
    name: f.name,
    mime: f.mime ?? 'application/octet-stream',
    size: f.size ?? 0,
    width: f.width ?? undefined,
    height: f.height ?? undefined,
    hasThumb: f.thumb ? true : undefined,
  }
}

function toUser(row: UserRow): User {
  return { id: row.id, name: row.name, role: row.role as Role, createdAt: row.created_at }
}

function toMessage(row: MessageRow): Message {
  const message: Message = {
    id: row.id,
    channelId: row.channel_id,
    seq: row.seq,
    authorId: row.author_id,
    kind: row.kind as MessageKind,
    body: row.body,
    clientMsgId: row.client_msg_id ?? undefined,
    createdAt: row.created_at,
  }
  if (row.file_id && row.file_name !== null) {
    message.file = toFileMeta({
      id: row.file_id,
      name: row.file_name,
      mime: row.file_mime,
      size: row.file_size,
      width: row.file_width,
      height: row.file_height,
      thumb: row.file_thumb,
    })
  }
  return message
}

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  // -- users ----------------------------------------------------------------

  createUser(name: string, pinHash: string, role: Role): User {
    const user: User = { id: newId(), name, role, createdAt: Date.now() }
    this.db
      .prepare('INSERT INTO users (id, name, role, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, user.name, user.role, pinHash, user.createdAt)
    return user
  }

  getUserByName(name: string): (User & { pinHash: string }) | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE name = ?').get(name) as
      | UserRow
      | undefined
    return row ? { ...toUser(row), pinHash: row.pin_hash } : undefined
  }

  getUserById(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
    return row ? toUser(row) : undefined
  }

  listUsers(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY name').all() as unknown as UserRow[]
    return rows.map(toUser)
  }

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    return row.n
  }

  updateUserPin(id: string, pinHash: string): boolean {
    const result = this.db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(pinHash, id)
    return result.changes > 0
  }

  // -- sessions -------------------------------------------------------------

  createSession(token: string, userId: string): void {
    const now = Date.now()
    this.db
      .prepare('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)')
      .run(token, userId, now, now)
  }

  getSessionUser(token: string, ttlMs?: number): User | undefined {
    const cutoff = ttlMs ? Date.now() - ttlMs : 0
    const row = this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.last_seen >= ?`,
      )
      .get(token, cutoff) as UserRow | undefined
    return row ? toUser(row) : undefined
  }

  touchSession(token: string): void {
    this.db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(Date.now(), token)
  }

  /** Drop sessions idle past the TTL; run at startup so the table can't grow forever. */
  pruneSessions(ttlMs: number): number {
    const { changes } = this.db
      .prepare('DELETE FROM sessions WHERE last_seen < ?')
      .run(Date.now() - ttlMs)
    return Number(changes)
  }

  // -- channels -------------------------------------------------------------

  createChannel(name: string, kind: ChannelKind, topic = ''): Channel {
    const channel: Channel = { id: newId(), name, kind, topic, lastSeq: 0, createdAt: Date.now() }
    this.db
      .prepare('INSERT INTO channels (id, name, kind, topic, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(channel.id, channel.name, channel.kind, channel.topic, channel.createdAt)
    return channel
  }

  getChannel(id: string): Channel | undefined {
    const row = this.db
      .prepare(
        `SELECT c.*, COALESCE((SELECT MAX(seq) FROM messages m WHERE m.channel_id = c.id), 0) AS last_seq
         FROM channels c WHERE c.id = ?`,
      )
      .get(id) as ChannelRow | undefined
    return row ? this.toChannel(row) : undefined
  }

  getChannelByName(name: string): Channel | undefined {
    const row = this.db
      .prepare(
        `SELECT c.*, COALESCE((SELECT MAX(seq) FROM messages m WHERE m.channel_id = c.id), 0) AS last_seq
         FROM channels c WHERE c.name = ?`,
      )
      .get(name) as ChannelRow | undefined
    return row ? this.toChannel(row) : undefined
  }

  /** Public channels (except retired) plus the DMs this user belongs to. */
  listChannelsFor(userId: string): Channel[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, COALESCE((SELECT MAX(seq) FROM messages m WHERE m.channel_id = c.id), 0) AS last_seq
         FROM channels c
         WHERE (c.kind = 'public' AND c.retired = 0)
            OR (c.kind = 'dm' AND EXISTS (
                 SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?))
         ORDER BY c.created_at`,
      )
      .all(userId) as unknown as ChannelRow[]
    return rows.map((row) => this.toChannel(row))
  }

  /** Every channel including retired ones and DMs, for the admin export. */
  listAllChannels(): Channel[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, COALESCE((SELECT MAX(seq) FROM messages m WHERE m.channel_id = c.id), 0) AS last_seq
         FROM channels c ORDER BY c.created_at`,
      )
      .all() as unknown as ChannelRow[]
    return rows.map((row) => this.toChannel(row))
  }

  updateChannel(
    id: string,
    patch: { name?: string; topic?: string; retired?: boolean },
  ): Channel | undefined {
    const sets: string[] = []
    const args: (string | number)[] = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      args.push(patch.name)
    }
    if (patch.topic !== undefined) {
      sets.push('topic = ?')
      args.push(patch.topic)
    }
    if (patch.retired !== undefined) {
      sets.push('retired = ?')
      args.push(patch.retired ? 1 : 0)
    }
    if (sets.length) {
      this.db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
    }
    return this.getChannel(id)
  }

  private toChannel(row: ChannelRow): Channel {
    const channel: Channel = {
      id: row.id,
      name: row.name,
      kind: row.kind as ChannelKind,
      topic: row.topic,
      lastSeq: row.last_seq,
      createdAt: row.created_at,
    }
    if (row.retired) channel.retired = true
    if (channel.kind === 'dm') {
      const members = this.db
        .prepare('SELECT user_id FROM channel_members WHERE channel_id = ?')
        .all(row.id) as unknown as { user_id: string }[]
      channel.memberIds = members.map((m) => m.user_id)
    }
    return channel
  }

  /** DM channels get a deterministic name so the same pair maps to one channel. */
  getOrCreateDm(userA: string, userB: string): Channel {
    const [a, b] = [userA, userB].sort()
    const name = `dm:${a}:${b}`
    return transaction(this.db, () => {
      const existing = this.getChannelByName(name)
      if (existing) return existing
      const channel = this.createChannel(name, 'dm')
      const insert = this.db.prepare(
        'INSERT INTO channel_members (channel_id, user_id, last_read_seq) VALUES (?, ?, 0)',
      )
      insert.run(channel.id, a)
      if (a !== b) insert.run(channel.id, b)
      channel.memberIds = a === b ? [a] : [a, b]
      return channel
    })
  }

  /** null means "everyone" (public channel); an array means DM members only. */
  channelAudience(channelId: string): string[] | null {
    const channel = this.getChannel(channelId)
    if (!channel) return []
    if (channel.kind === 'public') return null
    return channel.memberIds ?? []
  }

  isMember(channelId: string, userId: string): boolean {
    const audience = this.channelAudience(channelId)
    return audience === null || audience.includes(userId)
  }

  // -- messages -------------------------------------------------------------

  /**
   * Append a message, assigning the next per-channel seq. If clientMsgId was
   * already stored (client retry), returns the existing message unchanged —
   * sends are idempotent.
   */
  appendMessage(input: {
    channelId: string
    authorId: string | null
    kind: MessageKind
    body: string
    clientMsgId?: string
    fileId?: string
  }): { message: Message; deduped: boolean } {
    return transaction(this.db, () => {
      if (input.clientMsgId) {
        const existing = this.db
          .prepare(`${MSG_SELECT} WHERE m.client_msg_id = ?`)
          .get(input.clientMsgId) as unknown as MessageRow | undefined
        if (existing) return { message: toMessage(existing), deduped: true }
      }
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE channel_id = ?')
        .get(input.channelId) as { next: number }
      const message: Message = {
        id: newId(),
        channelId: input.channelId,
        seq: next,
        authorId: input.authorId,
        kind: input.kind,
        body: input.body,
        clientMsgId: input.clientMsgId,
        createdAt: Date.now(),
      }
      this.db
        .prepare(
          `INSERT INTO messages (id, channel_id, seq, author_id, kind, body, client_msg_id, created_at, file_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          message.channelId,
          message.seq,
          message.authorId,
          message.kind,
          message.body,
          message.clientMsgId ?? null,
          message.createdAt,
          input.fileId ?? null,
        )
      if (input.fileId) {
        const file = this.getFile(input.fileId)
        if (file) message.file = file
      }
      return { message, deduped: false }
    })
  }

  /** Up to `limit` messages with seq > afterSeq, ascending. */
  listAfter(channelId: string, afterSeq: number, limit: number): Message[] {
    const rows = this.db
      .prepare(`${MSG_SELECT} WHERE m.channel_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT ?`)
      .all(channelId, afterSeq, limit) as unknown as MessageRow[]
    return rows.map(toMessage)
  }

  /** The newest `limit` messages with seq > afterSeq, ascending. */
  listLatestAfter(channelId: string, afterSeq: number, limit: number): Message[] {
    const rows = this.db
      .prepare(`${MSG_SELECT} WHERE m.channel_id = ? AND m.seq > ? ORDER BY m.seq DESC LIMIT ?`)
      .all(channelId, afterSeq, limit) as unknown as MessageRow[]
    return rows.map(toMessage).reverse()
  }

  /** Scrollback: up to `limit` messages with seq < beforeSeq, ascending. */
  listBefore(channelId: string, beforeSeq: number, limit: number): Message[] {
    const rows = this.db
      .prepare(`${MSG_SELECT} WHERE m.channel_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`)
      .all(channelId, beforeSeq, limit) as unknown as MessageRow[]
    return rows.map(toMessage).reverse()
  }

  /** Messages surrounding one seq — powers "jump to message" from search. */
  listAround(channelId: string, seq: number, radius: number): Message[] {
    const rows = this.db
      .prepare(`${MSG_SELECT} WHERE m.channel_id = ? AND m.seq BETWEEN ? AND ? ORDER BY m.seq ASC`)
      .all(channelId, seq - radius, seq + radius) as unknown as MessageRow[]
    return rows.map(toMessage)
  }

  /** Every message across every channel, for the admin export. */
  listAllMessages(): Message[] {
    const rows = this.db
      .prepare(`${MSG_SELECT} ORDER BY m.channel_id, m.seq`)
      .all() as unknown as MessageRow[]
    return rows.map(toMessage)
  }

  getMessageById(id: string): Message | undefined {
    const row = this.db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(id) as unknown as
      | MessageRow
      | undefined
    return row ? toMessage(row) : undefined
  }

  /**
   * Delete a message, logging it for welcome-time reconciliation. The file
   * row and blob are removed only when nothing else references them —
   * uploads are deduped by content, so a path can back several file rows.
   */
  deleteMessage(id: string): boolean {
    const orphanedPath = transaction(this.db, () => {
      const row = this.db
        .prepare('SELECT channel_id, file_id FROM messages WHERE id = ?')
        .get(id) as { channel_id: string; file_id: string | null } | undefined
      if (!row) return undefined
      this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
      this.db
        .prepare('INSERT OR REPLACE INTO deleted_messages (message_id, channel_id, deleted_at) VALUES (?, ?, ?)')
        .run(id, row.channel_id, Date.now())
      if (!row.file_id) return undefined
      const { refs } = this.db
        .prepare('SELECT COUNT(*) AS refs FROM messages WHERE file_id = ?')
        .get(row.file_id) as { refs: number }
      if (refs > 0) return undefined
      const file = this.db.prepare('SELECT path FROM files WHERE id = ?').get(row.file_id) as
        | { path: string }
        | undefined
      if (!file) return undefined
      this.db.prepare('DELETE FROM files WHERE id = ?').run(row.file_id)
      const { siblings } = this.db
        .prepare('SELECT COUNT(*) AS siblings FROM files WHERE path = ?')
        .get(file.path) as { siblings: number }
      return siblings === 0 ? file.path : undefined
    })
    if (orphanedPath === undefined) {
      // Either the message never existed — report that — or no blob cleanup.
      return this.db.prepare('SELECT 1 FROM deleted_messages WHERE message_id = ?').get(id) !== undefined
    }
    try {
      unlinkSync(orphanedPath)
    } catch {
      // Blob already gone — the DB rows are the source of truth.
    }
    try {
      unlinkSync(`${orphanedPath}.thumb`)
    } catch {
      // No thumbnail for this blob.
    }
    return true
  }

  /** Deletions since `sinceMs` in the given channels, for the welcome payload. */
  listDeletions(channelIds: string[], sinceMs: number): { channelId: string; messageId: string }[] {
    if (!channelIds.length) return []
    const placeholders = channelIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT message_id, channel_id FROM deleted_messages
         WHERE deleted_at >= ? AND channel_id IN (${placeholders})`,
      )
      .all(sinceMs, ...channelIds) as { message_id: string; channel_id: string }[]
    return rows.map((r) => ({ channelId: r.channel_id, messageId: r.message_id }))
  }

  /** Full-text search over message bodies, newest first. */
  searchMessages(query: string, limit: number): Message[] {
    // Quote each term so user input can't break FTS5 syntax; * = prefix match.
    const terms = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replaceAll('"', '""')}"*`)
      .join(' ')
    if (!terms) return []
    try {
      const rows = this.db
        .prepare(
          `SELECT m.*, f.name AS file_name, f.mime AS file_mime, f.size AS file_size
           FROM messages_fts fts
           JOIN messages m ON m.rowid = fts.rowid
           LEFT JOIN files f ON f.id = m.file_id
           WHERE messages_fts MATCH ?
           ORDER BY m.created_at DESC LIMIT ?`,
        )
        .all(terms, limit) as unknown as MessageRow[]
      return rows.map(toMessage)
    } catch {
      return []
    }
  }

  // -- files ----------------------------------------------------------------

  createFile(meta: {
    name: string
    mime: string
    size: number
    sha256: string
    path: string
    width?: number
    height?: number
    thumbPath?: string
  }): FileMeta {
    const id = newId()
    this.db
      .prepare(
        `INSERT INTO files (id, name, mime, size, sha256, path, created_at, width, height, thumb_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        meta.name,
        meta.mime,
        meta.size,
        meta.sha256,
        meta.path,
        Date.now(),
        meta.width ?? null,
        meta.height ?? null,
        meta.thumbPath ?? null,
      )
    return toFileMeta({
      id,
      name: meta.name,
      mime: meta.mime,
      size: meta.size,
      width: meta.width ?? null,
      height: meta.height ?? null,
      thumb: meta.thumbPath ?? null,
    })
  }

  getFile(id: string): FileMeta | undefined {
    const row = this.getFileRow(id)
    return row ? toFileMeta({ ...row, thumb: row.thumb_path }) : undefined
  }

  getFileRow(id: string): FileRow | undefined {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as unknown as
      | FileRow
      | undefined
  }

  /** Existing stored blob with identical content, for dedupe. */
  findPathBySha(sha256: string): string | undefined {
    const row = this.db.prepare('SELECT path FROM files WHERE sha256 = ? LIMIT 1').get(sha256) as
      | { path: string }
      | undefined
    return row?.path
  }

  countAfter(channelId: string, afterSeq: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND seq > ?')
      .get(channelId, afterSeq) as { n: number }
    return row.n
  }

  // -- read state -----------------------------------------------------------

  setReadState(userId: string, channelId: string, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO channel_members (channel_id, user_id, last_read_seq) VALUES (?, ?, ?)
         ON CONFLICT (channel_id, user_id)
         DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`,
      )
      .run(channelId, userId, seq)
  }

  getReadState(userId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT channel_id, last_read_seq FROM channel_members WHERE user_id = ?')
      .all(userId) as { channel_id: string; last_read_seq: number }[]
    return Object.fromEntries(rows.map((r) => [r.channel_id, r.last_read_seq]))
  }

  // -- settings -------------------------------------------------------------

  /** Raw runtime setting, or undefined if never set (falls back to env/default). */
  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now())
  }
}
