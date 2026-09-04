import { findFixtureType } from './fixtures'
import { BAR_RESIDUAL_LIMIT, fitPosition } from './placement'
import type { Fixture, FixtureType, Position } from './types'

/**
 * How long a truss has to be to carry what's hanging on it.
 *
 * The plot knows the fixtures before anyone knows the truss — the design
 * arrives as a list, and the question on the production call is "how much
 * truss do I need to order". Working it out by hand is counting fixtures,
 * guessing at their width, and adding a bit; this does the same arithmetic
 * without the guessing, and says what it assumed.
 *
 * It is an estimate and reads like one. It doesn't know about motor points,
 * corner blocks, or the metre of truss at each end nobody hangs anything on.
 */

/**
 * Space a fixture takes along a bar, in metres, when its type doesn't say.
 *
 * A moving head is the common case and sits around 400 mm across its base.
 * Erring high is the safe direction: a truss that turns out longer than it
 * needed to be is an annoyance, one that turns out too short is a redesign
 * on the day.
 */
export const DEFAULT_FIXTURE_WIDTH = 0.4

/**
 * Air between two neighbours, in metres.
 *
 * Moving heads need room to pan without hitting each other, and even static
 * fixtures need room for a hand and a clamp. 250 mm is the number crews
 * actually leave.
 */
export const DEFAULT_GAP = 0.25

/**
 * Truss sold by the stick, in metres.
 *
 * The lengths every rental house stocks in 12-inch box truss. Anything can
 * be made from these because 0.5 m is in the list, which is what makes the
 * packing below always have an answer.
 */
export const STICK_LENGTHS = [0.5, 1, 1.5, 2, 2.5, 3, 4]

/** Everything is a whole number of these, which keeps the packing exact. */
const UNIT = 0.5

export interface TrussEstimate {
  /** Metres of bar the fixtures need, end to end. */
  needed: number
  /** Sticks to build it from, longest first. */
  sticks: number[]
  /** What those sticks add up to. Never less than `needed`. */
  built: number
  /**
   * How it was worked out. `coordinates` means the fixtures carry real
   * positions (an MVR import) and the span is measured rather than assumed;
   * `fixtures` means it was added up from widths and gaps.
   */
  basis: 'coordinates' | 'fixtures'
  fixtureCount: number
  /**
   * How many of the fixtures' widths came from a real profile rather than
   * `DEFAULT_FIXTURE_WIDTH`. An estimate built on the default is a guess
   * with arithmetic done to it, and should read as one.
   */
  measured: number
}

/**
 * Physical width of one fixture, in metres, and whether anything said so.
 *
 * A built-in type carries a rounded figure; an MVR-imported one carries the
 * dimensions out of its own GDTF models, which is the manufacturer's.
 */
export function fixtureWidth(fixture: Fixture, customTypes: FixtureType[]): number {
  return findFixtureType(fixture.typeId, customTypes)?.width ?? DEFAULT_FIXTURE_WIDTH
}

/** Whether that width was stated rather than assumed. */
export function widthIsKnown(fixture: Fixture, customTypes: FixtureType[]): boolean {
  return findFixtureType(fixture.typeId, customTypes)?.width !== undefined
}

/**
 * Sticks that reach at least `metres`, shortest total first and then fewest
 * sticks — so a 7.5 m run comes back as 4 + 3 + 0.5 rather than 4 + 4.
 * Truss is hired by the metre and stages have edges; a spare half-metre of
 * bar is a worse answer than one more coupler.
 *
 * Coin change on half-metre units. Because half a metre is itself a stock
 * length the exact target is always reachable, which is what makes "shortest
 * total" simply the target and leaves only the stick count to minimise.
 */
export function packSticks(metres: number): number[] {
  // A length that is not a length gets nothing, rather than a crash.
  // `needed` is arithmetic over widths that come out of a shared document
  // anyone can write to — an import with a garbage width, a hand-edited
  // number — and a NaN or an absurd span reaches `new Array(target + 1)` as
  // an "Invalid array length" thrown inside a render, which takes the whole
  // lighting pane down rather than one row of it.
  if (!Number.isFinite(metres) || metres > MAX_RUN_M) return []
  const target = Math.max(1, Math.ceil(metres / UNIT - 1e-9))
  // Longest first, so where two combinations tie on total and count the one
  // built from bigger sticks wins. Ties are common (3 + 0.5 and 2.5 + 1 are
  // both two sticks of 3.5 m) and a suggestion that flips between them
  // between renders is a suggestion nobody trusts.
  const coins = [...STICK_LENGTHS].sort((a, b) => b - a).map((length) => Math.round(length / UNIT))
  // best[t] = fewest sticks summing to exactly t; from[t] = one of them.
  const best = new Array<number>(target + 1).fill(Infinity)
  const from = new Array<number>(target + 1).fill(0)
  best[0] = 0
  for (let t = 1; t <= target; t++) {
    for (const coin of coins) {
      if (coin > t) continue
      const candidate = best[t - coin]! + 1
      if (candidate < best[t]!) {
        best[t] = candidate
        from[t] = coin
      }
    }
  }
  const sticks: number[] = []
  for (let t = target; t > 0; t -= from[t]!) sticks.push(from[t]! * UNIT)
  return sticks.sort((a, b) => b - a)
}

/**
 * The longest run this will suggest sticks for.
 *
 * Longer than any real position — the Pyramid's roof trusses are under
 * 40 m — so the only thing it excludes is arithmetic that has gone wrong.
 */
const MAX_RUN_M = 200

/**
 * What truss this position's fixtures need.
 *
 * Null when there is nothing useful to say: no fixtures, or a boom, whose
 * length is a stand height rather than a run of truss.
 */
export function estimateTruss(
  position: Position,
  fixtures: Fixture[],
  customTypes: FixtureType[]
): TrussEstimate | null {
  if (fixtures.length === 0 || position.kind === 'boom') return null

  const placed = fixtures.filter(
    (fixture): fixture is Fixture & { x: number; y: number } =>
      fixture.x !== null && fixture.y !== null
  )

  const widths = fixtures.map((fixture) => fixtureWidth(fixture, customTypes))
  let needed: number
  let basis: TrussEstimate['basis']

  const fit = placed.length >= 2 ? fitPosition(placed.map(({ x, y }) => ({ x, y }))) : null

  /**
   * Is the fitted span a measurement, or a drawing default?
   *
   * Two cases where it is not. Fixtures stacked at one coordinate — which
   * is most of an MVR whose author grouped by role rather than by hang —
   * have no direction to fit, so `fitPosition` returns its 12 m default;
   * reported as `coordinates` that reads as "measured off the plan" and
   * lands on a truss hire order. And a grouping spread across several
   * trusses fits a line through all of them, giving a span that measures a
   * distance nothing spans.
   *
   * Both fall back to the widths-and-gaps basis, which claims less and is
   * true: this many fixtures, at this size, need about this much bar.
   */
  const measurable = fit !== null && !fit.degenerate && fit.residual <= BAR_RESIDUAL_LIMIT

  if (fit && measurable) {
    // Real coordinates beat any assumption about spacing: this is the rig
    // someone actually drew, so measure it. `fitPosition` already finds the
    // span along the fixtures' own axis, which is the truss.
    // The span runs centre to centre, so half a fixture hangs off each end.
    const ends = (widths[0]! + widths[widths.length - 1]!) / 2
    needed = fit.length + ends
    basis = 'coordinates'
  } else {
    const total = widths.reduce((sum, width) => sum + width, 0)
    needed = total + DEFAULT_GAP * (fixtures.length - 1)
    basis = 'fixtures'
  }

  const sticks = packSticks(needed)
  // Nothing to suggest means nothing to say, rather than a row reading
  // "0 m of truss" beside a fixture count.
  if (sticks.length === 0) return null
  return {
    needed,
    sticks,
    built: sticks.reduce((sum, stick) => sum + stick, 0),
    basis,
    fixtureCount: fixtures.length,
    measured: fixtures.filter((fixture) => widthIsKnown(fixture, customTypes)).length,
  }
}

/** "2 × 4 m + 1 × 2 m" — how you'd write it on the truss order. */
export function describeSticks(sticks: number[]): string {
  const counts = new Map<number, number>()
  for (const stick of sticks) counts.set(stick, (counts.get(stick) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[0] - a[0])
    .map(([length, count]) => `${count} × ${length} m`)
    .join(' + ')
}
