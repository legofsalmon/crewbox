import type { ClientMessage, ServerMessage } from '@crewbox/shared'
import { pushSample, rollingMedian } from './quality.ts'
import { wsUrl } from './server.ts'

const HEARTBEAT_MS = 10_000
/**
 * Unanswered pings before the socket is called dead.
 *
 * Three at a ten-second cadence is the same half-minute of silence the wall
 * clock used to measure, and it tolerates a single lost pong — but it is
 * counted in *pings sent*, not in seconds elapsed, which is the whole
 * point. See `unansweredPings`.
 */
const DEAD_AFTER_PINGS = 3
const MAX_BACKOFF_MS = 10_000
/**
 * How long a socket may sit in CONNECTING before it is abandoned. A captive
 * portal or a black-hole network can leave a socket connecting forever,
 * firing neither onopen nor onclose — and because `connect()` bails while a
 * socket exists, that pins the client and turns every reconnect, the Retry
 * button included, into a no-op. This bounds the wait.
 */
const CONNECT_TIMEOUT_MS = 10_000
/**
 * How often this device tells the box what its round trip looks like, for the
 * network audit's crowd-Wi-Fi graph. One report a minute per phone is enough
 * to see an access point sag during doors, and cheap enough that a full crew
 * costs the box nothing. The server rate-limits it independently.
 */
const RTT_REPORT_MS = 60_000

export interface WsHandlers {
  /** Called before hello is sent; supplies auth + resume cursors. */
  hello: () => { token: string; cursors: Record<string, number> }
  onMessage: (msg: ServerMessage) => void
  onStatus: (status: 'connecting' | 'offline') => void
  /** Rolling median round-trip time, or null when unknown/disconnected. */
  onLatency?: (ms: number | null) => void
}

/**
 * Reconnecting WebSocket. Assumes disconnection is the normal state:
 * exponential backoff with jitter, app-level heartbeat to detect dead
 * sockets, and instant retry when the tab wakes up or the network returns.
 */
export class WsClient {
  private ws: WebSocket | null = null
  private attempts = 0
  private reconnectTimer: number | null = null
  private heartbeatTimer: number | null = null
  private connectTimer: number | null = null
  private stopped = false
  private rttSamples: number[] = []
  /**
   * When this device last reported its round trip. Deliberately NOT reset on
   * reconnect: a phone flapping at the edge of coverage would otherwise
   * report on every reconnect, which is exactly when it reconnects most.
   */
  private lastRttReport = 0

  constructor(private readonly handlers: WsHandlers) {
    window.addEventListener('online', this.wake)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.wake()
    })
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.ws?.close()
    this.ws = null
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  send(msg: ClientMessage): boolean {
    if (!this.connected) return false
    this.ws!.send(JSON.stringify(msg))
    return true
  }

  /** User tapped "Retry": drop any backoff and attempt to connect right now. */
  reconnectNow(): void {
    this.wake()
  }

  private wake = (): void => {
    if (this.stopped) return
    if (this.connected) {
      // Phone pulled out of a pocket: refresh the latency reading now.
      this.send({ type: 'ping', t: Date.now() })
      return
    }
    // A socket exists but isn't OPEN — it is stuck CONNECTING. Abandon it, or
    // the connect() below no-ops and Retry does nothing.
    this.dropSocket()
    this.attempts = 0
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.connect()
  }

  /** Tear down the current socket without triggering a scheduled reconnect. */
  private dropSocket(): void {
    if (!this.ws) return
    const ws = this.ws
    this.ws = null // so the onclose identity guard bails and won't reschedule
    this.clearTimers()
    try {
      ws.close()
    } catch {
      // already closing/closed
    }
  }

  private connect(): void {
    if (this.stopped || this.ws) return
    this.handlers.onStatus('connecting')
    const ws = new WebSocket(wsUrl())
    this.ws = ws
    // Force a stuck-CONNECTING socket closed so onclose frees this.ws and a
    // normal backoff reconnect follows — without this, a black-hole network
    // pins the client at "connecting" and no retry can recover.
    this.connectTimer = window.setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) ws.close()
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      if (this.connectTimer !== null) {
        clearTimeout(this.connectTimer)
        this.connectTimer = null
      }
      const { token, cursors } = this.handlers.hello()
      ws.send(JSON.stringify({ type: 'hello', token, cursors }))
      this.startHeartbeat()
    }
    ws.onmessage = (event) => {
      // Anything at all from the box proves the socket is carrying traffic.
      this.unansweredPings = 0
      let msg: ServerMessage
      try {
        msg = JSON.parse(event.data as string) as ServerMessage
      } catch {
        return
      }
      if (msg.type === 'welcome') {
        this.attempts = 0
        // Measure immediately so the UI has a number right after (re)connect.
        this.send({ type: 'ping', t: Date.now() })
      }
      if (msg.type === 'pong') {
        this.rttSamples = pushSample(this.rttSamples, Date.now() - msg.t)
        const median = rollingMedian(this.rttSamples)
        this.handlers.onLatency?.(median)
        this.reportRtt(median)
      }
      this.handlers.onMessage(msg)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.clearTimers()
      this.rttSamples = []
      this.handlers.onLatency?.(null)
      if (!this.stopped) {
        this.handlers.onStatus('offline')
        this.scheduleReconnect()
      }
    }
    ws.onerror = () => ws.close()
  }

  /**
   * Hand the box this device's median round trip, at most once a minute.
   *
   * Rides the existing pong rather than a timer of its own: a pong is proof
   * the socket is alive and the median is fresh, so there is nothing to
   * schedule and nothing to tear down. Clamped to the protocol's range so a
   * phone that slept through a 10-minute set can't post a nonsense sample.
   */
  private reportRtt(median: number | null): void {
    if (median === null) return
    const now = Date.now()
    if (now - this.lastRttReport < RTT_REPORT_MS) return
    this.lastRttReport = now
    this.send({ type: 'rttReport', ms: Math.min(60_000, Math.max(0, Math.round(median))) })
  }

  private scheduleReconnect(): void {
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempts)
    const jitter = 0.7 + Math.random() * 0.6
    this.attempts += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, base * jitter)
  }

  /**
   * How many pings have gone out since anything came back.
   *
   * Deadness is measured per ping, not per wall-clock second. It used to be
   * "nothing heard for 25 s" — which is a statement about the *timer*, and
   * a background tab's timers are throttled to a minute or suspended
   * outright. So a phone in a pocket woke up, found the clock had moved,
   * and closed a socket that was perfectly alive: a reconnect and a fresh
   * welcome every time the screen came on, and a longer gap before the next
   * alert, on exactly the device that most needed neither.
   *
   * Pings that went unanswered are real evidence however late the ticks
   * were, because a pong would have arrived whenever it arrived. Throttling
   * now costs checks, not sockets.
   */
  private unansweredPings = 0

  private startHeartbeat(): void {
    this.unansweredPings = 0
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.connected) return
      if (this.unansweredPings >= DEAD_AFTER_PINGS) {
        // Half-open socket: three pings out, nothing back.
        this.ws?.close()
        return
      }
      this.unansweredPings++
      this.send({ type: 'ping', t: Date.now() })
    }, HEARTBEAT_MS)
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    if (this.connectTimer !== null) clearTimeout(this.connectTimer)
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.connectTimer = null
  }
}
