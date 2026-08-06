import type { IncomingMessage } from 'node:http'
import type { WebSocket, WebSocketServer } from 'ws'
import {
  clientMessageSchema,
  PROTOCOL_VERSION,
  type Channel,
  type ClientMessage,
  type DmxUniverseWire,
  type Message,
  type PublicConfig,
  type ServerMessage,
  type User,
} from '@crewbox/shared'
import type { DmxListener } from './dmx/listener.ts'
import type { Store } from './store.ts'
import { APP_VERSION } from './version.ts'

/** Max missed messages replayed per channel in the welcome payload. */
const MISSED_LIMIT = 200
/** Cap on total replayed messages across all channels in one welcome. */
const MISSED_TOTAL_LIMIT = 500
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
  /** Recent state-changing/fan-out action timestamps (typing, markRead,
   *  createChannel, openDm), for a second, looser flood limit. */
  actions: number[]
  /** Lighting universes this socket is watching; empty when it isn't. */
  dmxUniverses: number[]
  /** Whether it also wants live levels, which are the expensive part. */
  dmxLevels: boolean
  /** Last levels sent per universe, so only changes go out. */
  dmxSent: Map<number, Uint8Array>
  /** Last `everLit` sent per universe, so it only goes when it grows. */
  dmxEverLit: Map<number, string>
  /** Cheap fingerprint of the last state message, to avoid resending it. */
  dmxSummary?: string
}

/** Max `send` messages one socket may emit per window before being throttled. */
const SEND_LIMIT = 30
const SEND_WINDOW_MS = 10_000

/**
 * Second, looser limit for the other state-changing / fan-out message types.
 *
 * The `send` guard above stops a socket flooding chat, but `typing` (two
 * channel-audience lookups plus a broadcast to every socket), `markRead` (a DB
 * write), `createChannel` (a permanent row, a broadcast to everyone, a system
 * message) and `openDm` were all unthrottled — one stuck or hostile client
 * looping any of them at wire speed multiplied by every connected phone
 * saturates the box. 60/10 s is far above any human cadence (a fast typist
 * emits a typing ping a few times a second at most) and well below abuse.
 */
const ACTION_LIMIT = 60

/**
 * Backstop on public-channel creation for the whole box. createChannel has no
 * admin gate by design — crew make channels — but nothing bounded the total,
 * so a loop could fill the database with rows that broadcast to everyone. No
 * real event needs more than this many named channels.
 */
const MAX_PUBLIC_CHANNELS = 500

/**
 * How often watching clients hear about the lighting network.
 *
 * A rig runs at 44 Hz and a phone on festival Wi-Fi cannot have that, so the
 * box samples. Four times a second is faster than anyone can read and slow
 * enough to be nothing on the wire.
 */
const DMX_TICK_MS = 250

/**
 * Most level changes one universe may send in a tick.
 *
 * A strobe chase changes all 512 every frame; without a cap one rig could
 * saturate a phone. What doesn't fit waits for the next tick, so nothing is
 * lost — it just arrives a quarter-second late, which for a level readout is
 * indistinguishable from on time.
 */
const DMX_MAX_CHANGES = 96

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
  private dmxTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
    private readonly getPublicConfig: () => PublicConfig,
    private readonly sessionTtlMs?: number,
    private readonly trustProxy = false,
    /** Lighting network, when this box was asked to listen to one. */
    private readonly dmx?: DmxListener
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
    if (this.dmx) {
      this.dmxTimer = setInterval(() => {
        for (const conn of this.conns) if (conn.dmxUniverses.length > 0) this.pushDmx(conn)
      }, DMX_TICK_MS)
      this.dmxTimer.unref()
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.dmxTimer) clearInterval(this.dmxTimer)
    this.dmxTimer = null
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
      actions: [],
      dmxUniverses: [],
      dmxLevels: false,
      dmxSent: new Map(),
      dmxEverLit: new Map(),
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
        // Cosmetic and high-frequency: over the limit, drop it silently.
        if (this.overActionLimit(conn)) break
        this.onTyping(conn, conn.user, msg.channelId)
        break
      case 'markRead':
        // Read state re-syncs on the next welcome, so a dropped one is
        // harmless — drop silently rather than error.
        if (this.overActionLimit(conn)) break
        this.onMarkRead(conn, conn.user, msg.channelId, msg.seq)
        break
      case 'createChannel':
        if (this.overActionLimit(conn)) {
          this.send(conn.ws, { type: 'error', code: 'bad_request', message: 'slow down' })
          break
        }
        this.onCreateChannel(conn, conn.user, msg.name, msg.topic)
        break
      case 'openDm':
        if (this.overActionLimit(conn)) {
          this.send(conn.ws, { type: 'error', code: 'bad_request', message: 'slow down' })
          break
        }
        this.onOpenDm(conn, conn.user, msg.userId)
        break
      case 'dmxWatch':
        // Bounded by the schema (32 universes) and free of side effects —
        // this only decides what this socket is told about.
        conn.dmxUniverses = [...new Set(msg.universes)]
        conn.dmxLevels = msg.levels
        conn.dmxSent.clear()
        conn.dmxEverLit.clear()
        this.pushDmx(conn)
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
    // A repeated hello on the same socket must not double-count presence: the
    // close handler decrements exactly once, so onHello has to increment at
    // most once per connection. Remember whether this socket was already
    // authed before adopting the new identity, and reconcile below.
    const previous = conn.user
    conn.user = user

    const channels = this.store.listChannelsFor(user.id)
    const missed: Message[] = []
    const truncated: string[] = []
    // The per-channel cap alone is unbounded overall: a fresh client (empty
    // cursors) on a box with twenty channels would get 200 × 20 messages in
    // one JSON frame, stringified on the event loop and pushed over festival
    // Wi-Fi — and an AP blip re-hellos a hundred phones in the same second.
    // A global budget bounds the whole welcome; anything past it is marked
    // truncated, and the client backfills those channels over REST on demand.
    let budget = MISSED_TOTAL_LIMIT
    for (const channel of channels) {
      const afterSeq = msg.cursors[channel.id] ?? 0
      if (channel.lastSeq <= afterSeq) continue
      const perChannel = Math.min(MISSED_LIMIT, budget)
      if (perChannel <= 0) {
        // Out of budget, but this channel has unseen messages: let the client
        // fetch them itself rather than omitting them silently.
        truncated.push(channel.id)
        continue
      }
      // One more than we'll keep, so a full page signals truncation in the
      // same query — no separate COUNT probe.
      const batch = this.store.listLatestAfter(channel.id, afterSeq, perChannel + 1)
      if (batch.length > perChannel) {
        truncated.push(channel.id)
        missed.push(...batch.slice(batch.length - perChannel))
        budget -= perChannel
      } else {
        missed.push(...batch)
        budget -= batch.length
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
    // Count this socket exactly once. A first hello brings the user online; a
    // repeat on an already-authed socket is presence-idempotent (a client
    // re-sending hello can't inflate the online tally); a re-auth as someone
    // else — unusual, but possible — moves the one count from the old id to
    // the new so `close`'s single decrement still balances.
    if (!previous) {
      this.markOnline(user.id, conn.remote)
    } else if (previous.id !== user.id) {
      this.markOffline(previous.id, conn.remote)
      this.markOnline(user.id, conn.remote)
    }
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

  /** True (and records the attempt) once a socket is over its action limit. */
  private overActionLimit(conn: Conn): boolean {
    const now = Date.now()
    conn.actions = conn.actions.filter((t) => now - t < SEND_WINDOW_MS)
    if (conn.actions.length >= ACTION_LIMIT) return true
    conn.actions.push(now)
    return false
  }

  private onTyping(conn: Conn, user: User, channelId: string): void {
    if (!this.store.isMember(channelId, user.id)) return
    this.broadcastToChannel(channelId, { type: 'typing', channelId, userId: user.id }, conn.ws)
  }

  private onMarkRead(conn: Conn, user: User, channelId: string, seq: number): void {
    // Gate on membership like onSend/onTyping. setReadState upserts a
    // channel_members row, and those rows *define* DM membership — so an
    // unguarded markRead carrying a DM channel id the sender isn't in would
    // quietly make them a member and start feeding them that DM's history and
    // live traffic. A stale client cache replaying a markRead after the user
    // was deleted and re-registered hits this with no ill intent at all.
    if (!this.store.isMember(channelId, user.id)) return
    this.store.setReadState(user.id, channelId, seq)
    // Sync unread state to the same user's other devices.
    this.sendToUser(user.id, { type: 'readState', channelId, seq }, conn.ws)
  }

  private onCreateChannel(conn: Conn, user: User, name: string, topic: string): void {
    if (this.store.getChannelByName(name)) {
      this.send(conn.ws, { type: 'error', code: 'bad_request', message: `#${name} already exists` })
      return
    }
    if (this.store.countPublicChannels() >= MAX_PUBLIC_CHANNELS) {
      this.send(conn.ws, {
        type: 'error',
        code: 'bad_request',
        message: 'too many channels on this box — retire some first',
      })
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

  /**
   * Tell one watching socket what its universes are doing.
   *
   * Only what changed: `everLit` goes when it grows (it only ever gains
   * bits), and levels go as [address, level] pairs for addresses whose value
   * moved. A universe nobody is watching costs nothing, and a rig that is
   * sitting still costs one small state message a second.
   */
  private pushDmx(conn: Conn): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return
    if (!this.dmx) {
      this.send(conn.ws, { type: 'dmxState', listening: false, universes: [] })
      return
    }

    const health = new Map(this.dmx.state.health().map((u) => [u.universe, u]))
    const universes: DmxUniverseWire[] = []
    let stateChanged = false

    for (const universe of conn.dmxUniverses) {
      const found = health.get(universe)
      if (!found) continue
      const bitmap = this.dmx.state.everLitBitmap(universe)
      const everLit = bitmap ? Buffer.from(bitmap).toString('base64') : ''
      if (conn.dmxEverLit.get(universe) !== everLit) {
        conn.dmxEverLit.set(universe, everLit)
        stateChanged = true
      }
      const winner = found.sources.find((s) => s.id === found.winnerId)
      universes.push({
        universe,
        wireUniverse: found.wireUniverse,
        protocol: found.protocol,
        source: winner?.name || winner?.id.slice(0, 8) || '',
        sources: found.sources.length,
        conflict: found.conflict,
        sync: found.sync,
        syncAddress: found.syncAddress,
        since: found.since,
        lastSeen: found.lastSeen,
        everLit,
      })
    }

    // Source counts, conflicts and sync state change rarely; resending the
    // whole list every tick would be most of the traffic for none of the
    // information. Sync belongs in here — a rig freezing because its
    // synchronization stream stopped is exactly the change worth pushing.
    const summary = universes
      .map((u) => `${u.universe}:${u.sources}:${u.conflict}:${u.sync}:${u.syncAddress}`)
      .join(',')
    if (stateChanged || summary !== conn.dmxSummary) {
      conn.dmxSummary = summary
      this.send(conn.ws, { type: 'dmxState', listening: true, universes })
    }

    if (!conn.dmxLevels) return
    for (const universe of conn.dmxUniverses) {
      const slots = this.dmx.state.levels(universe)
      if (!slots) continue
      const previous = conn.dmxSent.get(universe)
      const values: Array<[number, number]> = []
      if (!previous) {
        // First look at this universe: everything that is on, so a client
        // arriving mid-show sees the state rather than only the next change.
        for (let i = 0; i < slots.length; i++) {
          if (slots[i] !== 0) values.push([i + 1, slots[i]!])
        }
        conn.dmxSent.set(universe, new Uint8Array(slots))
        this.send(conn.ws, { type: 'dmxLevels', universe, full: true, values })
        continue
      }
      for (let i = 0; i < slots.length && values.length < DMX_MAX_CHANGES; i++) {
        if (slots[i] !== previous[i]) {
          values.push([i + 1, slots[i]!])
          previous[i] = slots[i]!
        }
      }
      if (values.length > 0) {
        this.send(conn.ws, { type: 'dmxLevels', universe, full: false, values })
      }
    }
  }

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
