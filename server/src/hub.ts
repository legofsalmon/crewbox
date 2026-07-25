import type { IncomingMessage } from 'node:http'
import type { WebSocket, WebSocketServer } from 'ws'
import {
  clientMessageSchema,
  PROTOCOL_VERSION,
  type Channel,
  type ClientMessage,
  type Message,
  type PublicConfig,
  type ServerMessage,
  type User,
} from '@crewbox/shared'
import type { Store } from './store.ts'
import { APP_VERSION } from './version.ts'

/** Max missed messages replayed per channel in the welcome payload. */
const MISSED_LIMIT = 200
/** How far back welcome replays deletions so returning clients reconcile. */
const DELETION_REPLAY_MS = 7 * 24 * 60 * 60 * 1000
const HEARTBEAT_MS = 15_000

interface Conn {
  ws: WebSocket
  user: User | null
  alive: boolean
  /** Connection arrived from off the LAN (tunnel / public internet). */
  remote: boolean
  /** Recent `send` timestamps, for the per-connection flood limit. */
  sends: number[]
}

/** Max `send` messages one socket may emit per window before being throttled. */
const SEND_LIMIT = 30
const SEND_WINDOW_MS = 10_000

/** Dotted-quad form of an IPv4-mapped IPv6 address, or the input unchanged. */
function toV4(ip: string): string {
  const dotted = ip.replace(/^::ffff:/i, '')
  if (dotted !== ip && /^\d+\.\d+\.\d+\.\d+$/.test(dotted)) return dotted
  // Hex mapped form, e.g. ::ffff:c0a8:0164 → 192.168.1.100.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip)
  if (hex) {
    const hi = parseInt(hex[1]!, 16)
    const lo = parseInt(hex[2]!, 16)
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }
  return ip
}

/** RFC1918/loopback/link-local (v4 + mapped v6) — i.e. "on the site LAN". */
export function isPrivateIp(ip: string): boolean {
  const v4 = toV4(ip)
  if (/^(10\.|192\.168\.|127\.|169\.254\.)/.test(v4)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return true
  return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip)
}

/**
 * Off-site detection for the presence badge. Forwarded headers are only
 * honoured when the deploy actually sits behind a trusted proxy (trustProxy);
 * on a pure-LAN deploy they're ignored so a crew member can't spoof an
 * 'office' badge with a fake CF-Connecting-IP. Purely cosmetic either way —
 * a wrong badge is the worst a spoof achieves.
 */
export function isRemoteConnection(req: IncomingMessage | undefined, trustProxy = false): boolean {
  if (!req) return false
  const forwarded = trustProxy
    ? ((req.headers['cf-connecting-ip'] as string | undefined) ??
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim())
    : undefined
  const ip = forwarded ?? req.socket.remoteAddress ?? ''
  return ip !== '' && !isPrivateIp(ip)
}

interface Logger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export class Hub {
  private conns = new Set<Conn>()
  /** userId → number of open sockets. */
  private online = new Map<string, number>()
  /** userId → number of open on-site (LAN) sockets, for the office badge. */
  private localSockets = new Map<string, number>()
  private heartbeat: NodeJS.Timeout | null = null

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
    private readonly getPublicConfig: () => PublicConfig,
    private readonly sessionTtlMs?: number,
    private readonly trustProxy = false
  ) {}

  attach(wss: WebSocketServer): void {
    wss.on('connection', (ws, req) => this.onConnection(ws, req))
    this.heartbeat = setInterval(() => {
      for (const conn of this.conns) {
        if (!conn.alive) {
          conn.ws.terminate()
          continue
        }
        conn.alive = false
        conn.ws.ping()
      }
    }, HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const conn of this.conns) conn.ws.terminate()
  }

  stats(): { connections: number; onlineUsers: number } {
    return { connections: this.conns.size, onlineUsers: this.online.size }
  }

  // -- connection lifecycle -------------------------------------------------

  private onConnection(ws: WebSocket, req?: IncomingMessage): void {
    const conn: Conn = {
      ws,
      user: null,
      alive: true,
      remote: isRemoteConnection(req, this.trustProxy),
      sends: [],
    }
    this.conns.add(conn)

    ws.on('pong', () => {
      conn.alive = true
    })
    ws.on('message', (data) => {
      conn.alive = true
      try {
        this.onMessage(conn, JSON.parse(String(data)))
      } catch (err) {
        this.log.warn(`ws message error: ${String(err)}`)
        this.send(conn.ws, { type: 'error', code: 'bad_request', message: 'malformed message' })
      }
    })
    ws.on('close', () => {
      this.conns.delete(conn)
      if (conn.user) this.markOffline(conn.user.id, conn.remote)
    })
    ws.on('error', (err) => this.log.warn(`ws error: ${String(err)}`))
  }

  private onMessage(conn: Conn, raw: unknown): void {
    const parsed = clientMessageSchema.safeParse(raw)
    if (!parsed.success) {
      this.send(conn.ws, { type: 'error', code: 'bad_request', message: 'invalid message' })
      return
    }
    const msg = parsed.data

    if (msg.type === 'hello') {
      this.onHello(conn, msg)
      return
    }
    if (!conn.user) {
      this.send(conn.ws, { type: 'error', code: 'auth', message: 'hello required first' })
      conn.ws.close(4001, 'unauthenticated')
      return
    }

    switch (msg.type) {
      case 'send': {
        // Per-connection flood guard: one authenticated socket must not be
        // able to fan out unbounded traffic to every client. A human hitting
        // 30 messages / 10s is already implausibly fast.
        const now = Date.now()
        conn.sends = conn.sends.filter((t) => now - t < SEND_WINDOW_MS)
        if (conn.sends.length >= SEND_LIMIT) {
          this.send(conn.ws, {
            type: 'rejected',
            clientMsgId: msg.clientMsgId,
            reason: 'slow down — too many messages',
          })
          break
        }
        conn.sends.push(now)
        this.onSend(conn, conn.user, msg)
        break
      }
      case 'typing':
        this.onTyping(conn, conn.user, msg.channelId)
        break
      case 'markRead':
        this.onMarkRead(conn, conn.user, msg.channelId, msg.seq)
        break
      case 'createChannel':
        this.onCreateChannel(conn, conn.user, msg.name, msg.topic)
        break
      case 'openDm':
        this.onOpenDm(conn, conn.user, msg.userId)
        break
      case 'ping':
        this.send(conn.ws, { type: 'pong', t: msg.t })
        break
    }
  }

  // -- handlers -------------------------------------------------------------

  private onHello(conn: Conn, msg: Extract<ClientMessage, { type: 'hello' }>): void {
    const user = this.store.getSessionUser(msg.token, this.sessionTtlMs)
    if (!user) {
      this.send(conn.ws, { type: 'error', code: 'auth', message: 'invalid session' })
      conn.ws.close(4001, 'invalid session')
      return
    }
    this.store.touchSession(msg.token)
    conn.user = user

    const channels = this.store.listChannelsFor(user.id)
    const missed: Message[] = []
    const truncated: string[] = []
    for (const channel of channels) {
      const afterSeq = msg.cursors[channel.id] ?? 0
      if (channel.lastSeq <= afterSeq) continue
      if (this.store.countAfter(channel.id, afterSeq) > MISSED_LIMIT) {
        truncated.push(channel.id)
        missed.push(...this.store.listLatestAfter(channel.id, afterSeq, MISSED_LIMIT))
      } else {
        missed.push(...this.store.listAfter(channel.id, afterSeq, MISSED_LIMIT))
      }
    }

    this.send(conn.ws, {
      type: 'welcome',
      serverVersion: APP_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      config: this.getPublicConfig(),
      me: user,
      users: this.store.listUsers(),
      channels,
      readState: this.store.getReadState(user.id),
      online: [...this.online.keys()],
      remote: [...this.online.keys()].filter((id) => (this.localSockets.get(id) ?? 0) === 0),
      missed,
      truncated,
      deletions: this.store.listDeletions(
        channels.map((c) => c.id),
        Date.now() - DELETION_REPLAY_MS
      ),
    })
    this.markOnline(user.id, conn.remote)
  }

  private onSend(conn: Conn, user: User, msg: Extract<ClientMessage, { type: 'send' }>): void {
    const channel = this.store.getChannel(msg.channelId)
    if (!channel || !this.store.isMember(channel.id, user.id)) {
      this.send(conn.ws, {
        type: 'rejected',
        clientMsgId: msg.clientMsgId,
        reason: 'channel not found',
      })
      return
    }
    if (channel.retired) {
      this.send(conn.ws, {
        type: 'rejected',
        clientMsgId: msg.clientMsgId,
        reason: 'channel retired',
      })
      return
    }
    if (msg.fileId && !this.store.getFile(msg.fileId)) {
      this.send(conn.ws, {
        type: 'rejected',
        clientMsgId: msg.clientMsgId,
        reason: 'file not found',
      })
      return
    }
    if (!msg.fileId && !msg.body.trim()) {
      this.send(conn.ws, {
        type: 'rejected',
        clientMsgId: msg.clientMsgId,
        reason: 'empty message',
      })
      return
    }
    const { message, deduped } = this.store.appendMessage({
      channelId: channel.id,
      authorId: user.id,
      kind: msg.fileId ? 'file' : 'text',
      body: msg.body,
      clientMsgId: msg.clientMsgId,
      fileId: msg.fileId,
    })
    this.send(conn.ws, { type: 'ack', clientMsgId: msg.clientMsgId, message })
    if (!deduped) {
      this.broadcastToChannel(channel.id, { type: 'msg', message }, conn.ws)
    }
  }

  private onTyping(conn: Conn, user: User, channelId: string): void {
    if (!this.store.isMember(channelId, user.id)) return
    this.broadcastToChannel(channelId, { type: 'typing', channelId, userId: user.id }, conn.ws)
  }

  private onMarkRead(conn: Conn, user: User, channelId: string, seq: number): void {
    this.store.setReadState(user.id, channelId, seq)
    // Sync unread state to the same user's other devices.
    this.sendToUser(user.id, { type: 'readState', channelId, seq }, conn.ws)
  }

  private onCreateChannel(conn: Conn, user: User, name: string, topic: string): void {
    if (this.store.getChannelByName(name)) {
      this.send(conn.ws, { type: 'error', code: 'bad_request', message: `#${name} already exists` })
      return
    }
    const channel = this.store.createChannel(name, 'public', topic)
    this.broadcastAll({ type: 'channel', channel })
    this.systemMessage(channel.id, `#${channel.name} created by ${user.name}`)
  }

  private onOpenDm(conn: Conn, user: User, otherUserId: string): void {
    const other = this.store.getUserById(otherUserId)
    if (!other) {
      this.send(conn.ws, { type: 'error', code: 'not_found', message: 'user not found' })
      return
    }
    const channel = this.store.getOrCreateDm(user.id, other.id)
    for (const memberId of channel.memberIds ?? []) {
      this.sendToUser(memberId, { type: 'channel', channel })
    }
  }

  // -- helpers used by REST routes -----------------------------------------

  /** Announce a brand-new user to everyone connected. */
  announceUser(user: User): void {
    this.broadcastAll({ type: 'user', user })
  }

  /** Announce a created or admin-edited channel to everyone connected. */
  announceChannel(channel: Channel): void {
    this.broadcastAll({ type: 'channel', channel })
  }

  /** Push updated public settings (e.g. admin changed the Wi-Fi SSID). */
  announceConfig(): void {
    this.broadcastAll({ type: 'config', config: this.getPublicConfig() })
  }

  /** Tell a channel's audience a message was deleted (e.g. file removed). */
  announceDeleted(channelId: string, messageId: string): void {
    this.broadcastToChannel(channelId, { type: 'deleted', channelId, messageId })
  }

  /** Close every socket for a user (their session tokens are now invalid). */
  disconnectUser(userId: string): void {
    for (const conn of this.conns) {
      if (conn.user?.id === userId) {
        this.send(conn.ws, { type: 'error', code: 'auth', message: 'account deleted' })
        conn.ws.close(4001, 'account deleted')
      }
    }
  }

  systemMessage(channelId: string, body: string): Message {
    const { message } = this.store.appendMessage({
      channelId,
      authorId: null,
      kind: 'system',
      body,
    })
    this.broadcastToChannel(channelId, { type: 'msg', message })
    return message
  }

  // -- presence -------------------------------------------------------------

  private markOnline(userId: string, remote: boolean): void {
    const wasRemoteOnly = this.isRemoteOnly(userId)
    const count = this.online.get(userId) ?? 0
    this.online.set(userId, count + 1)
    if (!remote) this.localSockets.set(userId, (this.localSockets.get(userId) ?? 0) + 1)
    // Announce coming online, or an off-site user's on-site device appearing.
    if (count === 0 || wasRemoteOnly !== this.isRemoteOnly(userId)) {
      this.broadcastAll({
        type: 'presence',
        userId,
        online: true,
        remote: this.isRemoteOnly(userId),
      })
    }
  }

  private markOffline(userId: string, remote: boolean): void {
    const wasRemoteOnly = this.isRemoteOnly(userId)
    const count = this.online.get(userId) ?? 0
    if (!remote) {
      const local = (this.localSockets.get(userId) ?? 1) - 1
      if (local <= 0) this.localSockets.delete(userId)
      else this.localSockets.set(userId, local)
    }
    if (count <= 1) {
      this.online.delete(userId)
      this.localSockets.delete(userId)
      this.broadcastAll({ type: 'presence', userId, online: false })
    } else {
      this.online.set(userId, count - 1)
      // Their last on-site device left; they're still on from the office.
      if (wasRemoteOnly !== this.isRemoteOnly(userId)) {
        this.broadcastAll({
          type: 'presence',
          userId,
          online: true,
          remote: this.isRemoteOnly(userId),
        })
      }
    }
  }

  /** Online with not a single LAN socket — i.e. joining from off-site. */
  private isRemoteOnly(userId: string): boolean {
    return (this.online.get(userId) ?? 0) > 0 && (this.localSockets.get(userId) ?? 0) === 0
  }

  // -- transport ------------------------------------------------------------

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  private broadcastAll(msg: ServerMessage, except?: WebSocket): void {
    const payload = JSON.stringify(msg)
    for (const conn of this.conns) {
      if (conn.user && conn.ws !== except && conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(payload)
      }
    }
  }

  /** Deliver to a channel's audience (everyone for public, members for DMs). */
  private broadcastToChannel(channelId: string, msg: ServerMessage, except?: WebSocket): void {
    const audience = this.store.channelAudience(channelId)
    const payload = JSON.stringify(msg)
    for (const conn of this.conns) {
      if (!conn.user || conn.ws === except || conn.ws.readyState !== conn.ws.OPEN) continue
      if (audience === null || audience.includes(conn.user.id)) {
        conn.ws.send(payload)
      }
    }
  }

  private sendToUser(userId: string, msg: ServerMessage, except?: WebSocket): void {
    const payload = JSON.stringify(msg)
    for (const conn of this.conns) {
      if (conn.user?.id === userId && conn.ws !== except && conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(payload)
      }
    }
  }
}
