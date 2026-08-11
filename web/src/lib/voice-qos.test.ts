import { describe, expect, it } from 'vitest'
import { DECODE_SAMPLE_RATE, qosBetween, worstQos, type ReceiverSample } from './voice-qos.ts'

/**
 * The arithmetic behind "was comms breaking up".
 *
 * Worth pinning precisely because every number here is a difference between
 * two cumulative counters, and every plausible mistake — reading one sample
 * as an absolute, letting a reset go negative, dividing by the wrong window —
 * produces a number that still looks like a percentage.
 */

const sample = (over: Partial<ReceiverSample> = {}): ReceiverSample => ({
  packetsLost: 0,
  packetsReceived: 0,
  concealedSamples: 0,
  totalSamplesDuration: 0,
  jitter: 0,
  timestamp: 0,
  ...over,
})

/** One second of clean 48 kHz audio, as the counters would show it. */
const oneGoodSecond = (over: Partial<ReceiverSample> = {}): ReceiverSample =>
  sample({ packetsReceived: 50, totalSamplesDuration: 1, timestamp: 1000, ...over })

describe('reading one window, not the whole session', () => {
  it('measures only what happened between the two samples', () => {
    // The failure this pins: an hour of clean audio followed by one bad
    // minute reads as "1.6% loss" if the counters are treated as absolutes,
    // which is a shrug. Over the bad window alone it is 50%, which is a
    // call to action.
    const prev = sample({ packetsReceived: 100_000, packetsLost: 0, totalSamplesDuration: 3600 })
    const next = sample({
      packetsReceived: 100_050,
      packetsLost: 50,
      totalSamplesDuration: 3601,
      timestamp: 1000,
    })

    expect(qosBetween(prev, next)?.lossPct).toBe(50)
  })

  it('treats a counter that went backwards as no information', () => {
    // Republishing a track resets its counters. Subtracting across that
    // gives a negative delta, and a negative delta in the denominator
    // produces a confident, meaningless number.
    const prev = sample({ packetsReceived: 10_000, packetsLost: 200, totalSamplesDuration: 100 })
    const next = sample({
      packetsReceived: 20,
      packetsLost: 0,
      totalSamplesDuration: 1,
      timestamp: 1000,
    })

    // Null rather than zeros: a window whose counters ran backwards has no
    // valid evidence in it at all, and "0% loss" is a claim we cannot make.
    expect(qosBetween(prev, next)).toBeNull()
  })
})

describe('silence is not quality', () => {
  it('says nothing at all when no audio moved', () => {
    // The ordinary state of an intercom: joined, nobody talking. Reporting
    // a clean 0% every 15 seconds would bury one genuinely bad minute under
    // hours of good ones the moment anything averages them.
    expect(qosBetween(sample(), sample({ timestamp: 1000 }))).toBeNull()
  })

  it('reports as soon as there is anything to report', () => {
    expect(qosBetween(sample(), oneGoodSecond())).not.toBeNull()
  })
})

describe('concealment — the number the ear actually hears', () => {
  it('is the share of the audio the decoder had to invent', () => {
    // A tenth of a second fabricated inside one second of sound.
    const next = oneGoodSecond({ concealedSamples: DECODE_SAMPLE_RATE / 10 })
    expect(qosBetween(sample(), next)?.concealedPct).toBeCloseTo(10, 5)
  })

  it('reads zero on clean audio', () => {
    expect(qosBetween(sample(), oneGoodSecond())?.concealedPct).toBe(0)
  })

  it('can be clean while loss looks alarming', () => {
    // Loss and jitter are what the network did; concealment is what the crew
    // heard. The buffer absorbing a burst is exactly this case, and it is
    // why concealment is reported rather than inferred from loss.
    const next = oneGoodSecond({ packetsLost: 50, concealedSamples: 0 })
    const qos = qosBetween(sample(), next)
    expect(qos?.lossPct).toBe(50)
    expect(qos?.concealedPct).toBe(0)
  })

  it('never exceeds a hundred per cent, whatever the counters claim', () => {
    const next = oneGoodSecond({ concealedSamples: DECODE_SAMPLE_RATE * 10 })
    expect(qosBetween(sample(), next)?.concealedPct).toBe(100)
  })
})

describe('jitter', () => {
  it('comes across in milliseconds, from the browser’s seconds', () => {
    expect(qosBetween(sample(), oneGoodSecond({ jitter: 0.042 }))?.jitterMs).toBeCloseTo(42, 5)
  })

  it('survives a browser that omits it', () => {
    expect(qosBetween(sample(), oneGoodSecond({ jitter: undefined }))?.jitterMs).toBe(0)
  })
})

describe('listening to several people at once', () => {
  it('reports the worst stream rather than the average', () => {
    // Someone whose lighting op is breaking up has a problem even while the
    // other three come through perfectly. Averaging is the arithmetic that
    // would hide it.
    const worst = worstQos([
      { lossPct: 0, jitterMs: 2, concealedPct: 0 },
      { lossPct: 0, jitterMs: 3, concealedPct: 0 },
      { lossPct: 40, jitterMs: 90, concealedPct: 12 },
    ])
    expect(worst).toEqual({ lossPct: 40, jitterMs: 90, concealedPct: 12 })
  })

  it('has nothing to say about nobody', () => {
    expect(worstQos([])).toBeNull()
  })
})
