/**
 * What the ear actually got, as opposed to what the network looked like.
 *
 * The box already knows how its own Wi-Fi is behaving — the audit watches
 * that from the outside, and every phone reports its WebSocket round trip.
 * None of that answers the question an audio lead actually asks, which is
 * "was anyone's comms breaking up just then, and whose". Only the receiving
 * browser knows, because only its decoder knows how much of the audio it had
 * to invent.
 *
 * Three numbers, chosen because each is a fact rather than an inference:
 *
 * - `lossPct` — packets that never arrived, as a share of those due.
 * - `jitterMs` — how unevenly they arrived. Reported by the browser directly.
 * - `concealedPct` — the one that matters. Opus conceals a gap by fabricating
 *   audio to cover it, and this is the share of the sound that was invented.
 *   Loss and jitter can both look poor while the buffer absorbs them and the
 *   crew hears nothing wrong; concealment is what they actually hear.
 *
 * All three are derived from *differences* between two samples, because the
 * browser's counters are cumulative for the life of the track. A reading
 * taken from one sample alone would be an average over the whole session and
 * would flatten exactly the short, bad minute worth reporting.
 */

/** The subset of the browser's audio receiver stats this needs. */
export interface ReceiverSample {
  packetsLost?: number
  packetsReceived?: number
  concealedSamples?: number
  /** Seconds of audio received, cumulative. */
  totalSamplesDuration?: number
  /** Seconds, per the WebRTC stats spec. */
  jitter?: number
  timestamp: number
}

export interface VoiceQos {
  lossPct: number
  jitterMs: number
  concealedPct: number
}

/**
 * Opus in LiveKit decodes at 48 kHz, which is what turns a duration into a
 * sample count for the concealment denominator. Named rather than inlined
 * because it is the one assumption here that could quietly go stale.
 */
export const DECODE_SAMPLE_RATE = 48_000

const delta = (next: number | undefined, prev: number | undefined): number => {
  const a = Number(next)
  const b = Number(prev)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  // Counters only climb. A negative step means the track was replaced under
  // us — treat it as no information rather than as a negative rate.
  return Math.max(0, a - b)
}

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0

/**
 * One track's quality over the window between two samples.
 *
 * Null when the window carries no evidence — no packets and no audio — which
 * is the normal state of an intercom nobody is talking on. Reporting zeros
 * there would bury a genuinely bad minute under hours of silent good ones.
 */
export function qosBetween(prev: ReceiverSample, next: ReceiverSample): VoiceQos | null {
  const received = delta(next.packetsReceived, prev.packetsReceived)
  const lost = delta(next.packetsLost, prev.packetsLost)
  const seconds = delta(next.totalSamplesDuration, prev.totalSamplesDuration)
  if (received + lost === 0 && seconds === 0) return null

  const concealed = delta(next.concealedSamples, prev.concealedSamples)
  const jitterSeconds = Number(next.jitter)

  return {
    lossPct: pct(lost, lost + received),
    jitterMs: Number.isFinite(jitterSeconds) ? Math.max(0, jitterSeconds * 1000) : 0,
    concealedPct: pct(concealed, seconds * DECODE_SAMPLE_RATE),
  }
}

/**
 * One reading for a device listening to several people at once.
 *
 * The worst stream wins, not the average. Someone whose lighting op is
 * breaking up has a problem even while the other three come through
 * perfectly, and an average over four streams is exactly the arithmetic that
 * would hide it.
 */
export function worstQos(readings: VoiceQos[]): VoiceQos | null {
  if (readings.length === 0) return null
  return {
    lossPct: Math.max(...readings.map((r) => r.lossPct)),
    jitterMs: Math.max(...readings.map((r) => r.jitterMs)),
    concealedPct: Math.max(...readings.map((r) => r.concealedPct)),
  }
}
