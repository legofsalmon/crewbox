import { describe, expect, it } from 'vitest'
import { Hub } from '../src/hub.ts'
import type { Store } from '../src/store.ts'

/**
 * The crowd-Wi-Fi link: a phone's own round trip, reported to the box, into
 * the audit's `crew.rtt` series.
 *
 * This is the one audit number the box cannot measure for itself — server-side
 * timings only ever prove the box is fast. So the property that matters is
 * that a client-reported figure actually reaches the collector, and that a
 * chatty or hostile socket can't flood it.
 */

const noopLog = { info() {}, warn() {}, error() {} } as never
const noConfig = () => ({ eventName: '', wifiSsid: '', voiceEnabled: false, modules: [] })

type Sink = NonNullable<Parameters<Hub['setCollector']>[0]>

/** A collector stub: supply the half a test cares about, get the rest free. */
const sink = (partial: Partial<Sink>): Sink => ({
  noteRtt: () => {},
  noteVoice: () => {},
  ...partial,
})

/** A hub with a fake authenticated socket, driven straight at `onMessage`. */
function socket(collector?: Sink) {
  const hub = new Hub({} as Store, noopLog, noConfig)
  hub.setCollector(collector)
  const sent: Array<Record<string, unknown>> = []
  const conn = {
    ws: { readyState: 1, OPEN: 1, send: (p: string) => sent.push(JSON.parse(p) as never) },
    user: { id: 'u1' },
    alive: true,
    remote: false,
    sends: [],
    actions: [],
    dmxUniverses: [],
    dmxLevels: false,
    dmxSent: new Map(),
    dmxEverLit: new Map(),
  }
  // `onMessage` is private by design — a socket is the only real caller.
  const deliver = (msg: unknown) =>
    (hub as never as { onMessage: (c: unknown, m: unknown) => void }).onMessage(conn, msg)
  return { deliver, sent }
}

describe('client-reported round trips', () => {
  it('hands the reported figure to the audit collector', () => {
    const seen: number[] = []
    const { deliver } = socket(sink({ noteRtt: (ms) => void seen.push(ms) }))

    deliver({ type: 'rttReport', ms: 412 })
    expect(seen).toEqual([412])
  })

  it('is silently ignored when the audit module is off', () => {
    // No collector set — the box must not answer, error, or throw.
    const { deliver, sent } = socket()
    expect(() => deliver({ type: 'rttReport', ms: 120 })).not.toThrow()
    expect(sent).toEqual([])
  })

  it('never answers a report — it is advisory, not a request', () => {
    const { deliver, sent } = socket(sink({}))
    deliver({ type: 'rttReport', ms: 90 })
    expect(sent).toEqual([])
  })

  it('a socket that floods reports is cut off by the action limit', () => {
    const seen: number[] = []
    const { deliver } = socket(sink({ noteRtt: (ms) => void seen.push(ms) }))

    // The action limit is 60 per window and shared with typing/markRead, so a
    // client sending far more than its once-a-minute budget stops landing.
    for (let i = 0; i < 200; i += 1) deliver({ type: 'rttReport', ms: 100 })

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.length).toBeLessThan(200)
  })
})

describe('what comms actually sounded like', () => {
  /**
   * The one measurement the box cannot take for itself. Server-side numbers
   * describe the box's own end of the wire and always look well from there;
   * only the receiving decoder knows how much of the audio it had to invent
   * to cover a gap.
   */
  it('carries a device report through to the collector', () => {
    const seen: Array<Record<string, number>> = []
    const { deliver } = socket(sink({ noteVoice: (stats) => void seen.push({ ...stats }) }))

    deliver({ type: 'voiceStats', lossPct: 12.5, jitterMs: 40, concealedPct: 3.25 })

    expect(seen).toEqual([{ lossPct: 12.5, jitterMs: 40, concealedPct: 3.25 }])
  })

  it('drops a report from a socket that is already being chatty', () => {
    // Same guard as every other client-driven action: a phone with a stuck
    // timer must not be able to bury the rollup under its own telemetry.
    const seen: unknown[] = []
    const { deliver } = socket(sink({ noteVoice: () => void seen.push(1) }))
    for (let i = 0; i < 400; i++) {
      deliver({ type: 'voiceStats', lossPct: 0, jitterMs: 0, concealedPct: 0 })
    }
    expect(seen.length).toBeLessThan(400)
  })

  it('never reaches the collector with a figure outside its bounds', () => {
    // These are computed on a device the box does not own. The schema is the
    // boundary, so a device claiming 900% concealment is rejected before any
    // of it is believed.
    const seen: unknown[] = []
    const { deliver } = socket(sink({ noteVoice: () => void seen.push(1) }))

    deliver({ type: 'voiceStats', lossPct: 0, jitterMs: 0, concealedPct: 900 })

    expect(seen).toHaveLength(0)
  })

  it('is ignored entirely when the audit module is off', () => {
    // No collector at all — the common case, and it must not throw.
    const { deliver } = socket(undefined)
    expect(() =>
      deliver({ type: 'voiceStats', lossPct: 5, jitterMs: 5, concealedPct: 5 })
    ).not.toThrow()
  })
})
