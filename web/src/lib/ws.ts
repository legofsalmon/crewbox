import type { ClientMessage, ServerMessage } from '@inter/shared'
import { pushSample, rollingMedian } from './quality.ts'

const HEARTBEAT_MS = 10_000
const DEAD_AFTER_MS = 25_000
const MAX_BACKOFF_MS = 10_000

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
  private lastActivity = 0
  private stopped = false
  private rttSamples: number[] = []

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

  private wake = (): void => {
    if (this.stopped) return
    if (this.connected) {
      // Phone pulled out of a pocket: refresh the latency reading now.
      this.send({ type: 'ping', t: Date.now() })
      return
    }
    this.attempts = 0
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.connect()
  }

  private connect(): void {
    if (this.stopped || this.ws) return
    this.handlers.onStatus('connecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws
    this.lastActivity = Date.now()

    ws.onopen = () => {
      const { token, cursors } = this.handlers.hello()
      ws.send(JSON.stringify({ type: 'hello', token, cursors }))
      this.startHeartbeat()
    }
    ws.onmessage = (event) => {
      this.lastActivity = Date.now()
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
        this.handlers.onLatency?.(rollingMedian(this.rttSamples))
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

  private scheduleReconnect(): void {
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempts)
    const jitter = 0.7 + Math.random() * 0.6
    this.attempts += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, base * jitter)
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.connected) return
      if (Date.now() - this.lastActivity > DEAD_AFTER_MS) {
        // Half-open socket: nothing heard for too long, force a reconnect.
        this.ws?.close()
        return
      }
      this.send({ type: 'ping', t: Date.now() })
    }, HEARTBEAT_MS)
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    this.reconnectTimer = null
    this.heartbeatTimer = null
  }
}
