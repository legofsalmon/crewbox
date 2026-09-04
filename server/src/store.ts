import type { DatabaseSync } from 'node:sqlite'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { newId } from '@crewbox/shared'
import type {
  Channel,
  ChannelKind,
  FileMeta,
  Incident,
  IncidentKind,
  IncidentSeverity,
  Message,
  MessageKind,
  Role,
  User,
} from '@crewbox/shared'
import { hashToken, transaction } from './db.ts'

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
/**
 * The settings key holding this database's identity.
 *
 * Reaches a real box's database — do not rename it, or every phone on site
 * drops its cache the next time it connects.
 */
export const DB_EPOCH_KEY = 'dbEpoch'

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
  /** The content's digest — and, with the box's files directory, its location. */
  sha256: string
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

interface IncidentRow {
  id: string
  seq: number
  author_id: string | null
  author_name: string
  kind: string
  severity: string
  body: string
  at: number
  logged_at: number
  stage: string
  act_id: string
  act_name: string
  amends: string | null
  client_msg_id: string | null
}

function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    seq: row.seq,
    authorId: row.author_id,
    authorName: row.author_name,
    kind: row.kind as IncidentKind,
    severity: row.severity as IncidentSeverity,
    body: row.body,
    at: row.at,
    loggedAt: row.logged_at,
    stage: row.stage,
    actId: row.act_id,
    actName: row.act_name,
    ...(row.amends ? { amends: row.amends } : {}),
    ...(row.client_msg_id ? { clientMsgId: row.client_msg_id } : {}),
  }
}

export class Store {
  constructor(
    private readonly db: DatabaseSync,
    /**
     * Where this box keeps uploaded blobs, when it takes uploads.
     *
     * Passed rather than read from a row, because a row's `path` was written
     * by whichever box did the upload — and `deploy/restore.sh` explicitly
     * supports restoring onto a *different* rig. See `blobPath`.
     */
    private readonly filesDir?: string
  ) {}

  /**
   * Where a blob is on *this* box.
   *
   * The layout has always been `<filesDir>/<sha256>`, so the location is a
   * fact about this box and the content, not something worth carrying in a
   * row. Storing it absolute meant every attachment and thumbnail 404'd after
   * a restore onto a spare rig, which is the one moment a crew most needs
   * their photographs of the patch.
   */
  blobPath(sha256: string): string | undefined {
    return this.filesDir ? join(this.filesDir, sha256) : undefined
  }

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
      UserRow | undefined
    return row ? { ...toUser(row), pinHash: row.pin_hash } : undefined
  }

  getUserById(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
    return row ? toUser(row) : undefined
  }

  /**
   * Delete a user account and its personal data (App Store requirement).
   * Sessions, DM memberships and read state go; authored messages are
   * anonymized (author_id → NULL) rather than deleted so channel history
   * stays continuous — they render as a former member. The name frees up
   * for re-registration. Order matters: clear the FK references before the
   * users row (author_id and channel_members both reference users(id)).
   */
  deleteUser(userId: string): void {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
      this.db.prepare('DELETE FROM channel_members WHERE user_id = ?').run(userId)
      this.db.prepare('UPDATE messages SET author_id = NULL WHERE author_id = ?').run(userId)
      // The show log keeps the entry and loses the person: what happened at
      // 21:04 is the event's record, who typed it is theirs. The name goes
      // with the id — leaving it would make "deleted my account" a promise
      // this table quietly broke.
      this.db
        .prepare("UPDATE incidents SET author_id = NULL, author_name = '' WHERE author_id = ?")
        .run(userId)
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    })
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

  /**
   * Start a session.
   *
   * Only the hash is stored. The token itself goes to the phone and is never
   * written down here — see migration v10 for why: the row ends up in every
   * backup, every snapshot and every USB stick anybody carries off site.
   */
  createSession(token: string, userId: string): void {
    const now = Date.now()
    this.db
      .prepare(
        'INSERT INTO sessions (token_sha, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)'
      )
      .run(hashToken(token), userId, now, now)
  }

  getSessionUser(token: string, ttlMs?: number): User | undefined {
    const cutoff = ttlMs ? Date.now() - ttlMs : 0
    const row = this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_sha = ? AND s.last_seen >= ?`
      )
      .get(hashToken(token), cutoff) as UserRow | undefined
    return row ? toUser(row) : undefined
  }

  touchSession(token: string): void {
    this.db
      .prepare('UPDATE sessions SET last_seen = ? WHERE token_sha = ?')
      .run(Date.now(), hashToken(token))
  }

  /** Drop sessions idle past the TTL; run at startup so the table can't grow forever. */
  /**
   * Forget deletions the replay window has passed.
   *
   * The table exists so a phone that was away when something was deleted is
   * told about it on the next welcome — after a week, nobody's cursor is
   * that old and the row is only a row. Nothing pruned it, so a box that
   * ran a season kept every deletion it had ever made and put them all in
   * every welcome.
   */
  pruneDeletions(olderThan: number): number {
    const before = this.db
      .prepare('SELECT COUNT(*) AS n FROM deleted_messages WHERE deleted_at < ?')
      .get(olderThan) as { n: number }
    this.db.prepare('DELETE FROM deleted_messages WHERE deleted_at < ?').run(olderThan)
    return before.n
  }

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
    const row = this.db.prepare(`SELECT c.* FROM channels c WHERE c.id = ?`).get(id) as
      ChannelRow | undefined
    return row ? this.toChannel(row) : undefined
  }

  getChannelByName(name: string): Channel | undefined {
    const row = this.db.prepare(`SELECT c.* FROM channels c WHERE c.name = ?`).get(name) as
      ChannelRow | undefined
    return row ? this.toChannel(row) : undefined
  }

  /** Public channels (except retired) plus the DMs this user belongs to. */
  listChannelsFor(userId: string): Channel[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM channels c
         WHERE (c.kind = 'public' AND c.retired = 0)
            OR (c.kind = 'dm' AND EXISTS (
                 SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?))
         ORDER BY c.created_at`
      )
      .all(userId) as unknown as ChannelRow[]
    return rows.map((row) => this.toChannel(row))
  }

  /**
   * How many live public channels exist — the backstop on createChannel.
   *
   * Retired ones do not count. They used to, which made the message the cap
   * sends ("retire some first") advice that could not work: retiring a
   * channel changed nothing, so a crew that hit the limit had no way past it
   * at all, on a box they cannot get into the database of.
   */
  countPublicChannels(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM channels WHERE kind = 'public' AND retired = 0`)
      .get() as { n: number }
    return row.n
  }

  /** Every channel including retired ones and DMs, for the admin export. */
  listAllChannels(): Channel[] {
    const rows = this.db
      .prepare(`SELECT c.* FROM channels c ORDER BY c.created_at`)
      .all() as unknown as ChannelRow[]
    return rows.map((row) => this.toChannel(row))
  }

  updateChannel(
    id: string,
    patch: { name?: string; topic?: string; retired?: boolean }
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
        'INSERT INTO channel_members (channel_id, user_id, last_read_seq) VALUES (?, ?, 0)'
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
      // A high-water mark, not `MAX(seq) + 1`. The old form handed the next
      // message the number the one just deleted had been using, and a phone
      // whose cursor sat on that number then asked for everything *after*
      // it — so the replacement never arrived on that phone, ever. Deleting
      // a photo shared by mistake is a supported thing to do; losing the
      // next message in the channel because of it is not.
      //
      // Inside the same transaction as the insert, so two sends landing
      // together cannot be given the same number.
      const bumped = this.db
        .prepare('UPDATE channels SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq')
        .get(input.channelId) as { last_seq: number } | undefined
      if (!bumped) throw new Error(`no such channel: ${input.channelId}`)
      const next = bumped.last_seq
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          input.fileId ?? null
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
      MessageRow | undefined
    return row ? toMessage(row) : undefined
  }

  /**
   * Delete a message, logging it for welcome-time reconciliation. The file
   * row and blob are removed only when nothing else references them —
   * uploads are deduped by content, so a path can back several file rows.
   */
  deleteMessage(id: string): boolean {
    const orphaned = transaction(this.db, () => {
      const row = this.db
        .prepare('SELECT channel_id, file_id FROM messages WHERE id = ?')
        .get(id) as { channel_id: string; file_id: string | null } | undefined
      if (!row) return undefined
      this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
      this.db
        .prepare(
          'INSERT OR REPLACE INTO deleted_messages (message_id, channel_id, deleted_at) VALUES (?, ?, ?)'
        )
        .run(id, row.channel_id, Date.now())
      if (!row.file_id) return undefined
      const { refs } = this.db
        .prepare('SELECT COUNT(*) AS refs FROM messages WHERE file_id = ?')
        .get(row.file_id) as { refs: number }
      if (refs > 0) return undefined
      const file = this.db
        .prepare('SELECT path, sha256 FROM files WHERE id = ?')
        .get(row.file_id) as { path: string; sha256: string } | undefined
      if (!file) return undefined
      this.db.prepare('DELETE FROM files WHERE id = ?').run(row.file_id)
      // Counted by content, not by the absolute path a row happens to carry:
      // after a restore onto another rig two rows for the same blob can hold
      // two different paths, and deleting one would take the other's bytes.
      const { siblings } = this.db
        .prepare('SELECT COUNT(*) AS siblings FROM files WHERE sha256 = ?')
        .get(file.sha256) as { siblings: number }
      return siblings === 0 ? file : undefined
    })
    if (orphaned === undefined) {
      // Either the message never existed — report that — or no blob cleanup.
      return (
        this.db.prepare('SELECT 1 FROM deleted_messages WHERE message_id = ?').get(id) !== undefined
      )
    }
    // Where it is now first, then where the row says it was. The second is
    // for a box that never moved and rows written before `blobPath`; both are
    // best-effort, because the database is the source of truth about what
    // exists and a blob left behind is disk, not a bug.
    for (const path of new Set([this.blobPath(orphaned.sha256), orphaned.path].filter(Boolean))) {
      for (const target of [path as string, `${path as string}.thumb`]) {
        try {
          unlinkSync(target)
        } catch {
          // Already gone, or never there.
        }
      }
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
         WHERE deleted_at >= ? AND channel_id IN (${placeholders})`
      )
      .all(sinceMs, ...channelIds) as { message_id: string; channel_id: string }[]
    return rows.map((r) => ({ channelId: r.channel_id, messageId: r.message_id }))
  }

  /**
   * Full-text search over message bodies this user can see, newest first.
   *
   * The membership check is in the query rather than after it. It used to be
   * a `.filter()` on the newest 50 hits, so a word that a crew member had
   * used a lot in their own DMs hid every public match behind them: fifty
   * rows fetched, fifty rows discarded, "no results" for a message that is
   * sitting in #general. On a box that has run a festival, that is most
   * searches for a common word.
   */
  searchMessages(query: string, userId: string, limit: number): Message[] {
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
           JOIN channels c ON c.id = m.channel_id
           LEFT JOIN files f ON f.id = m.file_id
           WHERE messages_fts MATCH ?
             AND (c.kind = 'public'
                  OR EXISTS (SELECT 1 FROM channel_members cm
                             WHERE cm.channel_id = m.channel_id AND cm.user_id = ?))
           ORDER BY m.created_at DESC LIMIT ?`
        )
        .all(terms, userId, limit) as unknown as MessageRow[]
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        meta.thumbPath ?? null
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
      FileRow | undefined
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
         DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`
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
  /**
   * Which database this is, minted once and kept for its life.
   *
   * Restoring a backup or swapping to a spare box brings a *different*
   * database, and the only thing that made them look the same was that
   * nothing ever asked. Sequence numbers count from wherever that database
   * had got to, so a spare box counts from below every phone's cursor and
   * every channel is skipped as "nothing new" — silently, on both sides.
   * This travels in the welcome so a phone can tell.
   *
   * It comes back with the rows in a restore, which is the point: a restored
   * database is the same database and keeps its epoch, while a spare box
   * mints its own.
   */
  dbEpoch(): string {
    const existing = this.getSetting(DB_EPOCH_KEY)
    if (existing) return existing
    const minted = newId()
    this.setSetting(DB_EPOCH_KEY, minted)
    return minted
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined
    return row?.value
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, Date.now())
  }

  // -- show log -------------------------------------------------------------
  //
  // Append and read. There is deliberately no update and no delete: a
  // correction is a new entry naming the one it corrects (see amends), the
  // way a paper log book is corrected, and both stay readable.

  /**
   * File an entry. Returns the stored row and whether it was already there.
   *
   * The dedupe is the same one chat uses, and it matters more here: a phone
   * that logs a show stop, loses Wi-Fi before the acknowledgement and retries
   * must not put two show stops in the record.
   */
  appendIncident(input: {
    authorId: string | null
    authorName: string
    kind: IncidentKind
    severity: IncidentSeverity
    body: string
    at: number
    stage?: string
    actId?: string
    actName?: string
    amends?: string
    clientMsgId?: string
  }): { incident: Incident; deduped: boolean } {
    return transaction(this.db, () => {
      if (input.clientMsgId) {
        const existing = this.db
          .prepare('SELECT * FROM incidents WHERE client_msg_id = ?')
          .get(input.clientMsgId) as unknown as IncidentRow | undefined
        if (existing) return { incident: toIncident(existing), deduped: true }
      }
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM incidents')
        .get() as { next: number }
      const incident: Incident = {
        id: newId(),
        seq: next,
        authorId: input.authorId,
        authorName: input.authorName,
        kind: input.kind,
        severity: input.severity,
        body: input.body,
        at: input.at,
        loggedAt: Date.now(),
        stage: input.stage ?? '',
        actId: input.actId ?? '',
        actName: input.actName ?? '',
        ...(input.amends ? { amends: input.amends } : {}),
        ...(input.clientMsgId ? { clientMsgId: input.clientMsgId } : {}),
      }
      this.db
        .prepare(
          `INSERT INTO incidents
             (id, seq, author_id, author_name, kind, severity, body, at, logged_at,
              stage, act_id, act_name, amends, client_msg_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          incident.id,
          incident.seq,
          incident.authorId,
          incident.authorName,
          incident.kind,
          incident.severity,
          incident.body,
          incident.at,
          incident.loggedAt,
          incident.stage,
          incident.actId,
          incident.actName,
          incident.amends ?? null,
          incident.clientMsgId ?? null
        )
      return { incident, deduped: false }
    })
  }

  /**
   * The log, newest first, for entries before `beforeSeq`.
   *
   * Ordered by seq rather than by `at`, because seq is the order the box
   * learned things and cannot be argued with; an entry back-dated by ten
   * minutes must not silently jump above one already read. The pane sorts by
   * `at` for display — that is a view, this is the record.
   */
  listIncidentsBefore(beforeSeq: number, limit: number): Incident[] {
    const rows = this.db
      .prepare('SELECT * FROM incidents WHERE seq < ? ORDER BY seq DESC LIMIT ?')
      .all(beforeSeq, limit) as unknown as IncidentRow[]
    return rows.map(toIncident)
  }

  /** Every entry in the window, oldest first — for the show report. */
  listIncidentsBetween(from: number, to: number): Incident[] {
    const rows = this.db
      .prepare('SELECT * FROM incidents WHERE at >= ? AND at <= ? ORDER BY seq')
      .all(from, to) as unknown as IncidentRow[]
    return rows.map(toIncident)
  }

  /** Highest seq in the log, or 0 when nothing has been filed. */
  latestIncidentSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM incidents').get() as {
      seq: number
    }
    return row.seq
  }
}
