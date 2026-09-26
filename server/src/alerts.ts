import type { WebSocket } from 'ws'
import {
  alertsClientFrameSchema,
  ALERTS_VERSION,
  BEAT_MS,
  BEATS_MISSED,
  CALL_CATCH_UP_MS,
  CATCH_UP_MS,
  DEFAULT_CHANNEL_ALERTS,
  incidentAlert,
  incidentAlerts,
  levelFor,
  messageAlert,
  messageAlertKind,
  shapeCatchUp,
  SOUND_GAP_MS,
  type Alert,
  type AlertChannelInput,
  type AlertsServerFrame,
  type Channel,
  type Incident,
  type Message,
  type StageCountdown,
  type User,
} from '@crewbox/shared'
import type { Store } from './store.ts'

/**
 * The alerts socket, `/ws/alerts`, and the box deciding what buzzes whom.
 *
 * The rules are shared/src/alerts.ts; this runs them for each person as
 * things happen, and sends each of their phones finished alerts. The page's
 * chat socket gets the same alerts through the hub, so its banner and chirp
 * follow the same rules as a lock screen (docs/ALERTS.md).
 *
 * A separate socket rather than a mode of `/ws`: the chat socket's hello
 * builds a full welcome (every user, every channel, up to hundreds of missed
 * messages), which an alerts connection, held by an iPhone's provider with a
 * 24 MiB memory limit, must never trigger.
 */

/** Most messages a catch-up reads back through, before the rules sort them. */
const CATCH_UP_SCAN = 5000

/** How far a catch-up reaches back before `since`, so a stepped clock loses nothing. */
const CATCH_UP_MARGIN_MS = 2 * 60_000

interface Logger {
  warn: (msg: string) => void
}

/** What the alerts socket needs of the hub: presence, and the page's copy of each alert. */
export interface AlertsHubLink {
  /** Count one more (or one fewer) socket for somebody, as the chat socket does. */
  addPresence(userId: string, remote: boolean): void
  dropPresence(userId: string, remote: boolean): void
  /** Everyone with a socket of either kind open, who might be told something. */
  onlineUserIds(): string[]
  /** Send an alert to this person's chat sockets, for the page. */
  alertPage(userId: string, alert: Alert): void
}

/** What the box knows of changeover calls and the countdown (Decision 2, 7). */
export interface StageSource {
  /** Calls made recently, with when; a catch-up takes the last two minutes of them. */
  recentCalls(since: number): Alert[]
  /** The countdown for somebody's followed stages, in their zone. */
  countdown(stages: string[], timeZone: string | undefined): StageCountdown[]
  start?(): void
  close?(): void
}

interface AlertsConn {
  ws: WebSocket
  user: User | null
  remote: boolean
  timeZone: string | undefined
  lastHeard: number
}

export interface AlertsOptions {
  sessionTtlMs?: number
  beatMs?: number
  now?: () => number
}

/** A usable IANA zone name, or undefined. */
function zoneOrNothing(zone: string | undefined): string | undefined {
  if (!zone) return undefined
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone })
    return zone
  } catch {
    return undefined
  }
}

export class AlertsHub {
  private conns = new Set<AlertsConn>()
  private beats: NodeJS.Timeout | null = null
  /** When each person's thread last sounded: `${userId}\n${thread}` → ms. */
  private sounded = new Map<string, number>()
  private hub: AlertsHubLink | undefined
  private stageSource: StageSource | undefined
  readonly beatMs: number
  private readonly now: () => number

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
    private readonly options: AlertsOptions = {}
  ) {
    this.beatMs = options.beatMs ?? BEAT_MS
    this.now = options.now ?? Date.now
  }

  link(hub: AlertsHubLink): void {
    this.hub = hub
  }

  setStages(source: StageSource): void {
    this.stageSource = source
  }

  start(): void {
    if (this.beats) return
    this.beats = setInterval(() => this.beat(), this.beatMs)
    this.beats.unref()
    this.stageSource?.start?.()
  }

  close(): void {
    if (this.beats) clearInterval(this.beats)
    this.beats = null
    this.stageSource?.close?.()
    for (const conn of this.conns) conn.ws.terminate()
  }

  stats(): { sockets: number } {
    return { sockets: this.conns.size }
  }

  // -- the socket -----------------------------------------------------------

  /**
   * A phone has opened `/ws/alerts`. The first frame says which event this
   * is, signed over the phone's challenge when the box can sign for the
   * address it was reached at; the phone sends its token only once that
   * checks out.
   */
  accept(ws: WebSocket, first: { eventId: string; signature?: string; remote: boolean }): void {
    const conn: AlertsConn = {
      ws,
      user: null,
      remote: first.remote,
      timeZone: undefined,
      lastHeard: this.now(),
    }
    this.conns.add(conn)
    this.send(conn, {
      type: 'box',
      v: ALERTS_VERSION,
      eventId: first.eventId,
      ...(first.signature ? { signature: first.signature } : {}),
      beatMs: this.beatMs,
      t: this.now(),
    })
    ws.on('message', (data) => {
      conn.lastHeard = this.now()
      let raw: unknown
      try {
        raw = JSON.parse(String(data))
      } catch {
        return
      }
      const parsed = alertsClientFrameSchema.safeParse(raw)
      // A frame this box doesn't know is ignored: a newer phone may send more.
      if (!parsed.success) return
      if (parsed.data.type === 'hello') this.onHello(conn, parsed.data)
    })
    ws.on('close', () => {
      this.conns.delete(conn)
      if (conn.user) this.hub?.dropPresence(conn.user.id, conn.remote)
    })
    ws.on('error', (err) => this.log.warn(`alerts socket error: ${String(err)}`))
  }

  private onHello(
    conn: AlertsConn,
    hello: { token: string; since: number | null; timeZone?: string | undefined }
  ): void {
    // One hello per socket. A second is somebody else's business entirely,
    // and re-authenticating a socket as another person is not a thing a
    // phone does.
    if (conn.user) return
    const user = this.store.getSessionUser(hello.token, this.options.sessionTtlMs)
    if (!user) {
      conn.ws.close(4001, 'invalid session')
      return
    }
    // Bookkeeping, never a reason to refuse, as on the chat socket.
    try {
      this.store.touchSession(hello.token)
    } catch (err) {
      this.log.warn(`could not record session activity: ${String(err)}`)
    }
    conn.user = user
    conn.timeZone = zoneOrNothing(hello.timeZone)
    this.hub?.addPresence(user.id, conn.remote)
    const settings = this.store.getAlertSettings(user.id)
    const { catchUp, more } =
      hello.since === null ? { catchUp: [], more: 0 } : this.catchUp(user, hello.since)
    this.send(conn, {
      type: 'welcome',
      t: this.now(),
      settings,
      catchUp,
      more,
      stages: this.stageSource?.countdown(settings.stages, conn.timeZone) ?? [],
    })
  }

  /** What somebody missed since `since`, unread, from the last 12 hours. */
  private catchUp(user: User, since: number): { catchUp: Alert[]; more: number } {
    const now = this.now()
    const from = Math.max(since - CATCH_UP_MARGIN_MS, now - CATCH_UP_MS)
    const settings = this.store.getAlertSettings(user.id)
    const read = this.store.getReadState(user.id)
    const names = new Map(this.store.listUsers().map((u) => [u.id, u.name]))
    const channels = new Map<string, Channel | undefined>()
    const alerts: Alert[] = []

    for (const message of this.store.listMessagesSince(from, CATCH_UP_SCAN)) {
      if (!channels.has(message.channelId)) {
        channels.set(message.channelId, this.store.getChannel(message.channelId))
      }
      const channel = channels.get(message.channelId)
      if (!channel) continue
      const kind = messageAlertKind({
        message,
        channel: channelInput(channel),
        person: user,
        level: levelFor(settings, channel.id),
        readSeq: read[channel.id] ?? 0,
      })
      if (!kind) continue
      alerts.push(
        messageAlert({
          message,
          channel: channelInput(channel),
          kind,
          authorName: message.authorId ? (names.get(message.authorId) ?? '') : '',
          quiet: true,
        })
      )
    }
    for (const incident of this.store.listIncidentsLoggedSince(from)) {
      if (incident.authorId === user.id || !incidentAlerts(incident)) continue
      alerts.push(incidentAlert(incident, true))
    }
    const followed = new Set(settings.stages)
    for (const call of this.stageSource?.recentCalls(Math.max(from, now - CALL_CATCH_UP_MS)) ??
      []) {
      if (call.target.kind === 'stage' && followed.has(call.target.stage)) alerts.push(call)
    }
    return shapeCatchUp(alerts)
  }

  /** Every `beatMs`: a beat to each socket, and the ones gone quiet for three closed. */
  private beat(): void {
    const now = this.now()
    for (const conn of this.conns) {
      if (now - conn.lastHeard > this.beatMs * BEATS_MISSED) {
        conn.ws.terminate()
        continue
      }
      this.send(conn, { type: 'beat', t: now })
    }
  }

  // -- things happening ------------------------------------------------------

  /** A message was posted. Everyone it is for, who is connected, is told. */
  onMessage(message: Message): void {
    if (!this.hub) return
    const channel = this.store.getChannel(message.channelId)
    if (!channel) return
    const state = this.store.channelAlertState(channel.id)
    const author = message.authorId ? this.store.getUserById(message.authorId) : undefined
    for (const userId of this.hub.onlineUserIds()) {
      const person = this.store.getUserById(userId)
      if (!person) continue
      const mine = state.get(userId)
      const kind = messageAlertKind({
        message,
        channel: channelInput(channel),
        person,
        level: mine?.level ?? DEFAULT_CHANNEL_ALERTS,
        readSeq: mine?.readSeq ?? 0,
      })
      if (!kind) continue
      this.deliver(
        userId,
        messageAlert({
          message,
          channel: channelInput(channel),
          kind,
          authorName: author?.name ?? '',
          quiet: this.soundedRecently(userId, channel.id),
        })
      )
    }
  }

  /** A show-log entry was filed. */
  onIncident(incident: Incident): void {
    if (!this.hub || !incidentAlerts(incident)) return
    for (const userId of this.hub.onlineUserIds()) {
      if (userId === incident.authorId) continue
      this.deliver(userId, incidentAlert(incident, this.soundedRecently(userId, 'showlog')))
    }
  }

  /** A changeover call, for everybody following its stage. */
  onCall(alert: Alert): void {
    if (!this.hub || alert.target.kind !== 'stage') return
    const stage = alert.target.stage
    for (const userId of this.hub.onlineUserIds()) {
      if (!this.store.getAlertSettings(userId).stages.includes(stage)) continue
      this.deliver(userId, { ...alert, quiet: this.soundedRecently(userId, alert.thread) })
    }
  }

  /** Somebody read a channel on one of their devices: their phones take its alerts back. */
  onRead(userId: string, channelId: string, seq: number): void {
    for (const conn of this.connsOf(userId)) {
      this.send(conn, { type: 'read', t: this.now(), channelId, seq })
    }
  }

  /** Alerts that are no longer true, for everyone who might hold them. */
  withdraw(ids: string[], audience: string[] | null): void {
    if (ids.length === 0) return
    for (const conn of this.conns) {
      if (!conn.user) continue
      if (audience !== null && !audience.includes(conn.user.id)) continue
      this.send(conn, { type: 'withdraw', t: this.now(), ids })
    }
  }

  /** A message was deleted: its alert goes from every lock screen it reached. */
  onDeleted(channelId: string, messageId: string): void {
    this.withdraw([`m:${messageId}`], this.store.channelAudience(channelId))
  }

  /** Somebody changed their settings on one of their devices. */
  onSettings(userId: string): void {
    const settings = this.store.getAlertSettings(userId)
    for (const conn of this.connsOf(userId)) {
      this.send(conn, { type: 'settings', t: this.now(), settings })
      this.send(conn, {
        type: 'stages',
        t: this.now(),
        stages: this.stageSource?.countdown(settings.stages, conn.timeZone) ?? [],
      })
    }
  }

  /** The running order changed: everyone's countdown again. */
  onStagesChanged(): void {
    if (!this.stageSource) return
    for (const conn of this.conns) {
      if (!conn.user) continue
      const settings = this.store.getAlertSettings(conn.user.id)
      if (settings.stages.length === 0) continue
      this.send(conn, {
        type: 'stages',
        t: this.now(),
        stages: this.stageSource.countdown(settings.stages, conn.timeZone),
      })
    }
  }

  /** Their session is gone: close every alerts socket they hold. */
  disconnectUser(userId: string): void {
    for (const conn of this.connsOf(userId)) conn.ws.close(4001, 'account deleted')
  }

  // -- plumbing -------------------------------------------------------------

  private deliver(userId: string, alert: Alert): void {
    if (!alert.quiet) this.sounded.set(`${userId}\n${alert.thread}`, this.now())
    for (const conn of this.connsOf(userId)) {
      this.send(conn, { type: 'alert', t: this.now(), alert })
    }
    this.hub?.alertPage(userId, alert)
  }

  /** One sound per thread per 30 seconds; anything sooner arrives quiet. */
  private soundedRecently(userId: string, thread: string): boolean {
    const at = this.sounded.get(`${userId}\n${thread}`)
    return at !== undefined && this.now() - at < SOUND_GAP_MS
  }

  private connsOf(userId: string): AlertsConn[] {
    return [...this.conns].filter((conn) => conn.user?.id === userId)
  }

  private send(conn: AlertsConn, frame: AlertsServerFrame): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(frame))
  }
}

function channelInput(channel: Channel): AlertChannelInput {
  return {
    id: channel.id,
    name: channel.name,
    kind: channel.kind,
    ...(channel.retired ? { retired: true } : {}),
    ...(channel.memberIds ? { memberIds: channel.memberIds } : {}),
  }
}
