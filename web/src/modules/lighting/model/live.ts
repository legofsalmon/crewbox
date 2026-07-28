import type { DmxUniverseWire } from '@crewbox/shared'
import { fixtureIntensity, intensityAddresses } from './gdtfLive'
import type { Fixture, FixtureType } from './types'

/**
 * What the lighting network is doing, mapped onto the plot.
 *
 * The box sends per-universe facts; only the plot knows where its fixtures are
 * addressed, so the join happens here. That also means the verdicts recompute
 * the instant someone changes an address, without asking the box anything.
 */

/** What can honestly be said about a fixture. */
export type FixtureVerdict = 'no-data' | 'silent' | 'live'

/** The `everLit` bitmap, unpacked. 64 bytes, one bit per address, LSB first. */
export function decodeEverLit(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const bitSet = (bits: Uint8Array, index: number): boolean =>
  (bits[index >> 3]! & (1 << (index & 7))) !== 0

/**
 * Has anything ever been sent to this fixture's addresses?
 *
 * Three answers, and none of them is "broken":
 *
 * - `no-data` — its universe hasn't been heard at all.
 * - `silent` — the universe is live, but the addresses that would light this
 *   fixture have been zero for as long as the box has been listening.
 * - `live` — one of them has been above zero at some point.
 *
 * A fixture sitting at zero right now is indistinguishable from a fixture
 * nobody is addressing, which is why `silent` is about the whole window and
 * why `live` never reverts. Between cues, everything is at zero.
 *
 * `intensity` narrows the question to the fixture's dimmer channels, which
 * is a far sharper test — a moving head parked at a position carries a
 * non-zero pan value from the moment the desk boots, so judging the whole
 * footprint calls every head in the rig live before anyone has put a light
 * on stage. Pass null (the case without a GDTF profile) to fall back to the
 * footprint.
 */
export function fixtureVerdict(
  fixture: Pick<Fixture, 'universe' | 'address' | 'footprint'>,
  everLit: Map<number, Uint8Array>,
  intensity?: number[] | null
): FixtureVerdict {
  const bits = everLit.get(fixture.universe)
  if (!bits) return 'no-data'
  if (fixture.address < 1 || fixture.address > 512) return 'no-data'

  if (intensity && intensity.length > 0) {
    for (const address of intensity) {
      if (address >= 1 && address <= 512 && bitSet(bits, address - 1)) return 'live'
    }
    return 'silent'
  }

  const from = fixture.address - 1
  const to = Math.min(from + Math.max(1, fixture.footprint), 512)
  for (let i = from; i < to; i++) {
    if (bitSet(bits, i)) return 'live'
  }
  return 'silent'
}

/**
 * The highest value anywhere in a fixture's footprint, 0–255.
 *
 * Deliberately **not** called intensity. Without a GDTF profile nothing here
 * knows which of a moving head's 16 channels is the dimmer, so a head that is
 * panning hard and dark would read as "full" if this claimed to be brightness.
 * What it honestly means is "the most that is being asked of this fixture",
 * which is enough to watch a rig respond to a cue and not enough to mistake
 * for a visualiser.
 */
export function fixturePeak(
  fixture: Pick<Fixture, 'universe' | 'address' | 'footprint'>,
  levels: Map<number, Uint8Array>
): number | null {
  const slots = levels.get(fixture.universe)
  if (!slots || fixture.address < 1) return null
  const from = fixture.address - 1
  const to = Math.min(from + Math.max(1, fixture.footprint), slots.length)
  let peak = 0
  for (let i = from; i < to; i++) peak = Math.max(peak, slots[i]!)
  return peak
}

export interface LiveSummary {
  /** Fixtures whose universe is arriving and whose addresses have been used. */
  live: number
  /** Universe arriving, addresses never used. */
  silent: number
  /** Universe never heard. */
  missing: number
  /** Earliest "listening since" across the universes in play, or null. */
  since: number | null
  /** Universes with two sources at the top priority. */
  conflicts: number[]
  /** How many of the counted fixtures were judged on their dimmer alone. */
  profiled: number
}

/** One line for the plot header: how much of this rig is being sent to. */
export function liveSummary(
  fixtures: Fixture[],
  everLit: Map<number, Uint8Array>,
  universes: DmxUniverseWire[],
  customTypes: FixtureType[] = []
): LiveSummary {
  const summary: LiveSummary = {
    live: 0,
    silent: 0,
    missing: 0,
    since: null,
    conflicts: [],
    profiled: 0,
  }
  for (const fixture of fixtures) {
    const intensity = intensityAddresses(fixture, customTypes)
    if (intensity) summary.profiled++
    const verdict = fixtureVerdict(fixture, everLit, intensity)
    if (verdict === 'live') summary.live++
    else if (verdict === 'silent') summary.silent++
    else summary.missing++
  }
  for (const universe of universes) {
    summary.since =
      summary.since === null ? universe.since : Math.min(summary.since, universe.since)
    if (universe.conflict) summary.conflicts.push(universe.universe)
  }
  return summary
}

/** Universes a plot's fixtures actually use, for the watch request. */
export function universesInPlot(fixtures: Fixture[]): number[] {
  return [...new Set(fixtures.map((f) => f.universe))].sort((a, b) => a - b).slice(0, 32)
}

/**
 * How brightly to draw a fixture, 0–1, when levels are being watched.
 *
 * Applied as opacity over the fixture's existing status colour rather than
 * replacing it, so a rig stays readable as paperwork while it moves. Never
 * reaches zero: a fixture at 0 is still a fixture that is rigged there, and
 * disappearing it would be a worse drawing.
 *
 * With a GDTF profile this is the dimmer; without one it is the peak in the
 * footprint, and a head slewing in the dark draws bright. `fixtureIntensity`
 * says which of the two it was.
 */
export function fixtureDim(
  fixture: Pick<Fixture, 'typeId' | 'mode' | 'universe' | 'address' | 'footprint'>,
  levels: Map<number, Uint8Array>,
  customTypes: FixtureType[] = []
): number {
  const intensity = fixtureIntensity(fixture, customTypes, levels)
  if (!intensity) return 1
  return 0.25 + 0.75 * intensity.level
}
