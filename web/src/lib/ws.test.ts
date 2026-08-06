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

  send(): void {}
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

// Mirror the module constant so the test reads intent, not a magic number.
const CONNECT_TIMEOUT_MS = 10_000
