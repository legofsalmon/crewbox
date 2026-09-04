// @vitest-environment happy-dom
//
// The reliability property under test: a socket that never finishes the
// WebSocket handshake — captive portal, black-hole network — must not pin the
// client at "connecting" forever. Reported from the field as "Retry does
// nothing": a stuck-CONNECTING socket kept `connect()` bailing (`if (this.ws)`)
// so every reconnect, the button included, was a no-op.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./server.ts', () => ({ wsUrl: () => 'ws://box.test/ws' }))

import { WsClient, type WsHandlers } from './ws.ts'

/** A WebSocket that stays CONNECTING until the test drives it. */
class FakeWs {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWs[] = []

  readyState = FakeWs.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closeCalls = 0
  /** Frames this socket was asked to send, for the RTT-report assertions. */
  sent: string[] = []

  constructor(readonly url: string) {
    FakeWs.instances.push(this)
  }

  close(): void {
    this.closeCalls += 1
    // A real socket transitions to CLOSED and fires onclose asynchronously;
    // do it synchronously here so the reconnect path is exercised in-test.
    if (this.readyState === FakeWs.CLOSED) return
    this.readyState = FakeWs.CLOSED
    this.onclose?.()
  }

  /** Simulate the handshake completing. */
  open(): void {
    this.readyState = FakeWs.OPEN
    this.onopen?.()
  }

  send(data: string): void {
    this.sent.push(data)
  }
}

function makeHandlers(): WsHandlers {
  return {
    hello: () => ({ token: 't', cursors: {} }),
    onMessage: vi.fn(),
    onStatus: vi.fn(),
    onLatency: vi.fn(),
  }
}

describe('WsClient connect timeout', () => {
  beforeEach(() => {
    FakeWs.instances = []
    vi.stubGlobal('WebSocket', FakeWs)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('force-closes a socket that never leaves CONNECTING', () => {
    const client = new WsClient(makeHandlers())
    client.start()
    const socket = FakeWs.instances[0]!
    expect(socket.readyState).toBe(FakeWs.CONNECTING)

    // Nothing happens before the timeout elapses.
    vi.advanceTimersByTime(9_000)
    expect(socket.closeCalls).toBe(0)

    // At the timeout the stuck socket is closed, which frees this.ws and
    // schedules a normal backoff reconnect.
    vi.advanceTimersByTime(2_000)
    expect(socket.closeCalls).toBe(1)
    expect(socket.readyState).toBe(FakeWs.CLOSED)

    client.stop()
  })

  it('does not force-close a socket that connected in time', () => {
    const client = new WsClient(makeHandlers())
    client.start()
    const socket = FakeWs.instances[0]!
    socket.open()

    // Past the connect deadline (10s) but shy of the half-open dead-socket
    // timeout (25s): if the connect timer were still armed it would fire here.
    vi.advanceTimersByTime(12_000)
    expect(socket.closeCalls).toBe(0)
    expect(socket.readyState).toBe(FakeWs.OPEN)

    client.stop()
  })

  it('survives a tab whose timers were throttled', () => {
    // Deadness used to be "nothing heard for 25 seconds", which is a
    // statement about the *timer* — and a background tab's timers are
    // clamped to a minute or suspended outright. So a phone in a pocket
    // woke up, found the clock had moved, and closed a socket that was
    // perfectly alive: a reconnect and a fresh welcome every time the
    // screen came on, on the device that could least afford either.
    const client = new WsClient(makeHandlers())
    client.start()
    const socket = FakeWs.instances[0]!
    socket.open()

    // The clock moves five minutes without the interval firing — which is
    // exactly what a throttled or suspended tab does — and then one tick
    // arrives. The socket has been answering; it must not be closed.
    vi.setSystemTime(Date.now() + 300_000)
    vi.advanceTimersByTime(10_000)
    expect(socket.closeCalls).toBe(0)
    expect(socket.readyState).toBe(FakeWs.OPEN)
    // ...and that tick sent a ping rather than giving up.
    expect(socket.sent.some((f) => (JSON.parse(f) as { type: string }).type === 'ping')).toBe(true)

    client.stop()
  })

  it('still closes a socket that stops answering', () => {
    const client = new WsClient(makeHandlers())
    client.start()
    const socket = FakeWs.instances[0]!
    socket.open()

    // Pings go out and nothing comes back. Three of them is the same half
    // minute of silence the wall clock used to measure.
    vi.advanceTimersByTime(45_000)
    expect(socket.closeCalls).toBeGreaterThan(0)

    client.stop()
  })

  it('Retry abandons a stuck-CONNECTING socket and opens a fresh one', () => {
    const client = new WsClient(makeHandlers())
    client.start()
    const first = FakeWs.instances[0]!
    expect(first.readyState).toBe(FakeWs.CONNECTING)

    // User taps Retry while the first socket is still hanging.
    client.reconnectNow()

    // The stuck socket is dropped and a second connection is opened — the
    // old bug left `first` in place and created nothing.
    expect(first.closeCalls).toBe(1)
    expect(FakeWs.instances).toHaveLength(2)
    expect(FakeWs.instances[1]!.readyState).toBe(FakeWs.CONNECTING)

    client.stop()
  })

  it('schedules a reconnect after a timed-out socket closes', () => {
    const client = new WsClient(makeHandlers())
    client.start()
    const first = FakeWs.instances[0]!

    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS)
    expect(first.readyState).toBe(FakeWs.CLOSED)

    // Backoff is 500ms * jitter (0.7–1.3) for the first attempt; well within 2s.
    vi.advanceTimersByTime(2_000)
    expect(FakeWs.instances.length).toBeGreaterThanOrEqual(2)

    client.stop()
  })
})

/**
 * The crowd-Wi-Fi half of the network audit: every phone hands the box its own
 * median round trip once a minute, so the audit can say the Wi-Fi is slow
 * rather than inferring it from server-side numbers that always look fine.
 */
describe('WsClient RTT reporting', () => {
  beforeEach(() => {
    FakeWs.instances = []
    vi.stubGlobal('WebSocket', FakeWs)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Connect, and answer every ping the client sends with a pong `rtt` ms later. */
  function connected(): { client: WsClient; socket: FakeWs; pong: (rtt: number) => void } {
    const client = new WsClient(makeHandlers())
    client.start()
    const socket = FakeWs.instances[0]!
    socket.open()
    const pong = (rtt: number): void => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'pong', t: Date.now() - rtt }) })
    }
    return { client, socket, pong }
  }

  const reports = (socket: FakeWs): Array<{ type: string; ms: number }> =>
    socket.sent
      .map((s) => JSON.parse(s) as { type: string; ms: number })
      .filter((m) => m.type === 'rttReport')

  it('reports the median round trip, at most once a minute', () => {
    const { client, socket, pong } = connected()

    pong(120)
    expect(reports(socket)).toEqual([{ type: 'rttReport', ms: 120 }])

    // Pongs keep arriving through the minute (they must — 25 s of silence
    // would trip the half-open check and close the socket), and none of them
    // produces a second report.
    for (const step of [20_000, 20_000]) {
      vi.advanceTimersByTime(step)
      pong(130)
    }
    expect(reports(socket)).toHaveLength(1)

    // Past the minute, the next pong reports again — the median of the
    // samples, not the latest single spike.
    vi.advanceTimersByTime(22_000)
    pong(130)
    expect(reports(socket)).toHaveLength(2)
    expect(reports(socket)[1]!.ms).toBe(130)

    client.stop()
  })

  it('says nothing until it has actually measured something', () => {
    const { client, socket } = connected()
    // Connected, pings sent, but no pong has come back yet.
    vi.advanceTimersByTime(120_000)
    expect(reports(socket)).toEqual([])
    client.stop()
  })

  it('clamps a nonsense sample into the protocol range', () => {
    const { client, socket, pong } = connected()
    // A phone that slept through a set wakes with an enormous delta.
    pong(9_000_000)
    expect(reports(socket)).toEqual([{ type: 'rttReport', ms: 60_000 }])
    client.stop()
  })

  it('does not report again just because a flapping phone reconnected', () => {
    const { client, socket, pong } = connected()
    pong(200)
    expect(reports(socket)).toHaveLength(1)

    // Socket drops and comes back inside the minute — the reconnect itself
    // must not become a reporting trigger.
    socket.close()
    vi.advanceTimersByTime(2_000)
    const second = FakeWs.instances[FakeWs.instances.length - 1]!
    second.open()
    second.onmessage?.({ data: JSON.stringify({ type: 'pong', t: Date.now() - 200 }) })
    expect(reports(second)).toEqual([])

    client.stop()
  })
})

// Mirror the module constant so the test reads intent, not a magic number.
const CONNECT_TIMEOUT_MS = 10_000
