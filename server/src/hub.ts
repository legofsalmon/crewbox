import type { IncomingMessage } from 'node:http'
import type { WebSocket, WebSocketServer } from 'ws'
import {
  clientMessageSchema,
  PROTOCOL_VERSION,
  SEND_LIMIT,
  SEND_WINDOW_MS,
  type Channel,
  type ClientMessage,
  type DmxUniverseWire,
  type Message,
  type PublicConfig,
  type ServerMessage,
  type User,
} from '@crewbox/shared'
import type { DmxListener } from './dmx/listener.ts'
import type { UniverseHealth } from './dmx/state.ts'
import type { Store } from './store.ts'
import { APP_VERSION } from './version.ts'

/** Max missed messages replayed per channel in the welcome payload. */
const MISSED_LIMIT = 200
/** Cap on total replayed messages across all channels in one welcome. */
const MISSED_TOTAL_LIMIT = 500
/** How far back welcome replays deletions so returning clients reconcile. */
export const DELETION_REPLAY_MS = 7 * 24 * 60 * 60 * 1000
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
  /**
   * Where the level diff stopped scanning last tick, per universe.
   *
   * The scan is capped, and it used to restart at address 1 every time. A
   * chase touching more than the cap in a tick therefore re-sent the same
   * low addresses for ever and never reached the high ones: on a rig where
   * the movers are patched above the LED wash, the plot showed the wash
   * moving and the movers frozen, indefinitely. Resuming from here and
   * wrapping means every changed address gets out within a handful of
   * ticks, whatever the desk is doing.
   */
  dmxScan: Map<number, number>
  /** Cheap fingerprint of the last state message, to avoid resending it. */
  dmxSummary?: string
}

/**
 * How far from the box's clock a show-log entry's time may be.
 *
 * A day either side. Back-dating by hours is ordinary — an entry written at
 * the end of a shift about something at the start of it — and a phone that
 * never reached NTP on an offline site is off by minutes, not months. What
 * this stops is the wrong-by-years clock putting the headliner's show stop
 * in 1970, where nobody would ever find it again.
 */
const INCIDENT_CLOCK_SLACK_MS = 24 * 60 * 60_000

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

/**
 * The slice of the audit collector this hub writes to.
 *
 * Structural rather than an import so hub.ts stays free of the audit module
 * — the box runs perfectly well without it, and the hub should not know
 * whether it is there.
 */
/** The on-air state, as much of it as the hub needs to touch. */
interface TallySource {
  current: () => { userId: string | null; since: number }
  /** Drop a tally pointing at somebody who has gone. Returns true if it did. */
  forget: (userId: string) => boolean
}

interface CollectorSink {
  noteRtt: (ms: number) => void
  noteVoice: (stats: { lossPct: number; jitterMs: number; concealedPct: number }) => void
}

interface Logger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

/**
 * How long an on-air crew member may be off the network before the tally
 * gives up on them.
 *
 * iOS closes a WebSocket about thirty seconds after the app goes to the
 * background, and the person on camera is precisely the one not holding
 * their phone — so "their last socket closed" is not "they left", and
 * treating it as such made the red bar vanish for the whole crew mid-shot.
 *
 * Five minutes: longer than any shot plus the gap around it, short enough
 * that somebody who has actually gone home is not still on air by the next
 * scene. A vision desk can clear it at any point regardless; this is only
 * about what happens when nobody does.
 */
export const TALLY_GRACE_MS = 5 * 60_000

export class Hub {
  private conns = new Set<Conn>()
  /** userId → number of open sockets. */
  private online = new Map<string, number>()
  /** userId → number of open on-site (LAN) sockets, for the office badge. */
  private localSockets = new Map<string, number>()
  private heartbeat: NodeJS.Timeout | null = null
  private dmxTimer: NodeJS.Timeout | null = null
  /**
   * Where client-reported measurements go, when the audit module is on.
   *
   * Set after construction rather than injected, because the collector reads
   * this hub's stats — constructor injection either way would be circular.
   * Typed structurally so hub.ts stays free of audit imports.
   */
  private collector: CollectorSink | undefined

  /**
   * Who is on air, when a vision desk is driving one.
   *
   * Held by the hub rather than passed on every call so a device joining
   * mid-show learns it with everything else — a red bar that only appears on
   * the next cut is a red bar that is wrong for however long that takes.
   */
  private tally: TallySource | undefined

  /** Pending "they really have gone" timers, per user. See markOffline. */
  private tallyGrace = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
    private readonly getPublicConfig: () => PublicConfig,
    private readonly sessionTtlMs?: number,
    private readonly trustProxy = false,
    /** Lighting network, when this box was asked to listen to one. */
    private readonly dmx?: DmxListener,
    /** Injectable so the tally grace is testable without waiting minutes. */
    private readonly tallyGraceMs = TALLY_GRACE_MS
  ) {}

  /** Hand the audit collector what the crew's devices report. Off by default. */
  setCollector(collector: CollectorSink | undefined): void {
    this.collector = collector
  }

  /** Where the on-air state lives, so a late joiner is told with the rest. */
  setTally(tally: TallySource): void {
    this.tally = tally
  }

  /** Tell every device who is on air now. */
  broadcastTally(state: { userId: string | null; since: number }): void {
    this.broadcastAll({ type: 'tally', userId: state.userId, since: state.since })
  }

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
        // `health()` sorts every universe and rebuilds a public record for
        // every source in each. It used to run once per watching socket, so
        // a production desk, a lighting tablet and three phones watching the
        // same rig cost five identical rebuilds four times a second. The
        // answer is the same for all of them, so it is computed once and
        // handed down.
        const watching = [...this.conns].filter((conn) => conn.dmxUniverses.length > 0)
        // Nobody is looking: a rig with no pane open costs nothing at all,
        // which is most of the time on most boxes.
        if (watching.length === 0 || !this.dmx) return
        const health = new Map(this.dmx.state.health().map((u) => [u.universe, u]))
        for (const conn of watching) this.pushDmx(conn, health)
      }, DMX_TICK_MS)
      this.dmxTimer.unref()
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.dmxTimer) clearInterval(this.dmxTimer)
    this.dmxTimer = null
    for (const timer of this.tallyGrace.values()) clearTimeout(timer)
    this.tallyGrace.clear()
    for (const conn of this.conns) conn.ws.terminate()
  }

  /** Start the countdown to forgetting an on-air crew member who dropped. */
  private scheduleTallyForget(userId: string): void {
    if (this.tally?.current().userId !== userId) return
    this.clearTallyGrace(userId)
    const timer = setTimeout(() => {
      this.tallyGrace.delete(userId)
      if (this.tally?.forget(userId)) this.broadcastTally(this.tally.current())
    }, this.tallyGraceMs)
    // Never a reason to hold the process open — a box shutting down has no
    // tally to clear.
    timer.unref?.()
    this.tallyGrace.set(userId, timer)
  }

  private clearTallyGrace(userId: string): void {
    const timer = this.tallyGrace.get(userId)
    if (!timer) return
    clearTimeout(timer)
    this.tallyGrace.delete(userId)
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
      dmxScan: new Map(),
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
      // Counted like everything else, and the most expensive thing this
      // socket can ask for: a session lookup, a database write, and a
      // welcome built out of every channel this user is in. A legitimate
      // client sends exactly one per connection; being the one message
      // allowed before authentication is not a reason to be free, it is a
      // reason to be careful.
      if (this.overActionLimit(conn)) {
        this.send(conn.ws, { type: 'error', code: 'bad_request', message: 'slow down' })
        conn.ws.close(4008, 'too many handshakes')
        return
      }
      this.onHello(conn, msg)
      return
    }
    if (!conn.user) {
      // `handshake`, not `auth`: this says nothing about the session, only
      // that this socket has not presented it yet. Sent as `auth` it told the
      // client its token was dead, and the client believed it — dropped the
      // token, wiped IndexedDB and reloaded to the join screen. See
      // ErrorMessage.
      this.send(conn.ws, { type: 'error', code: 'handshake', message: 'hello required first' })
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
          // `retry`, because this is the box saying "not now" rather than
          // anything about the message. Without it the client deleted the
          // entry, and a phone replaying an outbox after a dead spot lost
          // everything past the thirtieth. See RejectedMessage.
          this.send(conn.ws, {
            type: 'rejected',
            clientMsgId: msg.clientMsgId,
            reason: 'slow down — too many messages',
            retry: true,
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
        conn.dmxScan.clear()
        // The summary too, or a subscription can get no reply at all.
        //
        // `pushDmx` only sends when the summary changed — which is right for
        // a tick, and wrong for a *new* watch: re-watching a set of universes
        // the box has never heard from produces the same summary as last
        // time, so nothing goes out. The client has just set `listening:
        // false` in its own cleanup, so the live bar reads "this box is not
        // listening to Art-Net or sACN" while the admin panel says it is
        // listening on sixteen universes. At get-in, before the desk is
        // outputting, that is exactly where an LX programmer lands.
        delete conn.dmxSummary
        this.pushDmx(conn)
        break
      case 'ping':
        this.send(conn.ws, { type: 'pong', t: msg.t })
        break
      case 'rttReport':
        // Advisory only — it feeds a graph, never a decision. Dropped
        // silently when the audit module is off or the socket is chatty.
        if (this.overActionLimit(conn)) break
        this.collector?.noteRtt(msg.ms)
        break
      case 'voiceStats':
        // Same posture as rttReport: a graph, not a decision. The numbers
        // are computed on a device the box does not own, so the schema has
        // already bounded them before they reach here.
        if (this.overActionLimit(conn)) break
        this.collector?.noteVoice({
          lossPct: msg.lossPct,
          jitterMs: msg.jitterMs,
          concealedPct: msg.concealedPct,
        })
        break
      case 'logIncident': {
        // The same flood guard as `send`, and rejected the same way, because
        // this ends in the same place: a durable row and a broadcast to every
        // phone. Rejected rather than dropped — an entry somebody typed and
        // believes is filed must never disappear quietly.
        const now = Date.now()
        conn.sends = conn.sends.filter((t) => now - t < SEND_WINDOW_MS)
        if (conn.sends.length >= SEND_LIMIT) {
          this.send(conn.ws, {
            type: 'rejected',
            clientMsgId: msg.clientMsgId,
            reason: 'slow down — too many entries',
            retry: true,
          })
          break
        }
        conn.sends.push(now)
        this.onLogIncident(conn, conn.user, msg)
        break
      }
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
    // Bookkeeping, and never a reason to fail a hello. It is an UPDATE, so on
    // a full disk it throws — and it sat above `conn.user = user`, so the
    // throw left an authenticated crew member on an unauthenticated socket.
    // Their next ping earned "hello required first", which the client read as
    // a dead session: token dropped, IndexedDB wiped, outbox and all, back to
    // the join screen. Re-joining then failed too, because that is another
    // write. A box short of disk signed out every phone on site.
    try {
      this.store.touchSession(msg.token)
    } catch (err) {
      this.log.warn(`could not record session activity: ${String(err)}`)
    }
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
      const claimed = msg.cursors[channel.id] ?? 0
      // A cursor past the end of the channel is a cursor from another
      // database — a restore, or a spare box. Believing it skips the channel
      // silently, so it is treated as no cursor at all and the client gets
      // the tail. `dbEpoch` above is how the client knows to drop what it was
      // holding; this is what gets it something to replace it with, including
      // on a client too old to read the epoch.
      const afterSeq = claimed > channel.lastSeq ? 0 : claimed
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
      // Which database this is. A phone that sees it change knows its cursors
      // and its cached messages belong to one that is no longer here.
      dbEpoch: this.store.dbEpoch(),
    })
    // Straight after the welcome, and only when somebody is actually live:
    // a device joining mid-show has to arrive already knowing, or its red
    // bar is wrong until the next cut.
    const onAir = this.tally?.current()
    if (onAir?.userId) this.send(conn.ws, { type: 'tally', ...onAir })
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

  /**
   * File a show-log entry and tell everyone.
   *
   * Everyone, not a channel: there is one show and one log, and a box with
   * the module on shows it to every crew member who opens the pane.
   *
   * The clock is the one thing not taken on trust. `at` decides where an
   * entry sits in the night, and a phone with a wrong clock — the Android in
   * somebody's pocket that never got NTP on an offline site — would file the
   * headline act's show stop in 1970 or next Tuesday. A day either side is
   * enough for any real back-dating and stops that cold.
   */
  private onLogIncident(
    conn: Conn,
    user: User,
    msg: Extract<ClientMessage, { type: 'logIncident' }>
  ): void {
    const now = Date.now()
    if (Math.abs(msg.at - now) > INCIDENT_CLOCK_SLACK_MS) {
      this.send(conn.ws, {
        type: 'rejected',
        clientMsgId: msg.clientMsgId,
        reason: "that time is more than a day from the box's clock — check the phone's date",
      })
      return
    }
    const { incident, deduped } = this.store.appendIncident({
      authorId: user.id,
      authorName: user.name,
      kind: msg.kind,
      severity: msg.severity,
      body: msg.body,
      at: msg.at,
      stage: msg.stage,
      actId: msg.actId,
      actName: msg.actName,
      ...(msg.amends ? { amends: msg.amends } : {}),
      clientMsgId: msg.clientMsgId,
    })
    // Acked to the author either way, so a retry after a dropped
    // acknowledgement clears their outbox rather than filing a second copy.
    this.send(conn.ws, { type: 'incident', incident })
    if (!deduped) this.broadcastAll({ type: 'incident', incident }, conn.ws)
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
    // An account being deleted is somebody leaving on purpose, so the tally
    // goes now rather than waiting out the grace period below.
    this.clearTallyGrace(userId)
    if (this.tally?.forget(userId)) this.broadcastTally(this.tally.current())
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
    // They are back, so whatever their last dropped socket started, stop it.
    this.clearTallyGrace(userId)
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
      // The tally waits.
      //
      // A tally pointing at somebody who has left the event is a red bar
      // nobody can clear: not them, because they are gone, and not anyone
      // else, because it is not their bar. But "their last socket closed" is
      // not "they left" — iOS closes one about thirty seconds after the app
      // goes to the background, and the person on camera is precisely the one
      // who is not holding their phone. So the bar was vanishing for the whole
      // crew, mid-shot, because the subject pocketed a device.
      //
      // A grace period tells the two apart: long enough that a shot survives
      // it, short enough that somebody who has gone home stops being on air
      // before the next scene. Coming back cancels it. See TALLY_GRACE_MS.
      this.scheduleTallyForget(userId)
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
  private pushDmx(conn: Conn, shared: Map<number, UniverseHealth> | null = null): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return
    if (!this.dmx) {
      this.send(conn.ws, { type: 'dmxState', listening: false, universes: [] })
      return
    }

    // The tick computes this once for every watching socket. The fallback is
    // for the one caller that is not the tick.
    const health = shared ?? new Map(this.dmx.state.health().map((u) => [u.universe, u]))
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
        conn.dmxScan.set(universe, 0)
        this.send(conn.ws, { type: 'dmxLevels', universe, full: true, values })
        continue
      }
      // Round-robin, not from the top: see `dmxScan`. One pass at most, so
      // an idle universe costs one walk and a busy one hands out its cap.
      let at = conn.dmxScan.get(universe) ?? 0
      if (at >= slots.length) at = 0
      for (let seen = 0; seen < slots.length && values.length < DMX_MAX_CHANGES; seen++) {
        if (slots[at] !== previous[at]) {
          values.push([at + 1, slots[at]!])
          previous[at] = slots[at]!
        }
        at = (at + 1) % slots.length
      }
      conn.dmxScan.set(universe, at)
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
