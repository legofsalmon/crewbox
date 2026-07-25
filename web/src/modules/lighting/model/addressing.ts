import { DMX_UNIVERSE_SIZE, type Fixture } from './types'

/**
 * DMX addressing maths.
 *
 * A fixture occupies `footprint` consecutive channels starting at its
 * address, so two fixtures collide when those ranges overlap in the same
 * universe. That mistake is invisible in a spreadsheet and very visible on
 * stage — two heads doing the same thing, or one that won't respond — and
 * finding it at 2am is exactly what this module is for.
 *
 * Everything here is pure and works on a snapshot, so it's cheap to run on
 * every render and easy to test without a document.
 */

export interface AddressRange {
  universe: number
  /** Inclusive, 1-based. */
  start: number
  end: number
}

/** The channels a fixture occupies, or null if it isn't addressed yet. */
export const fixtureRange = (fixture: Fixture): AddressRange | null => {
  if (fixture.address <= 0 || fixture.footprint <= 0) return null
  return {
    universe: fixture.universe,
    start: fixture.address,
    end: fixture.address + fixture.footprint - 1,
  }
}

const overlaps = (a: AddressRange, b: AddressRange) =>
  a.universe === b.universe && a.start <= b.end && b.start <= a.end

/**
 * Fixture id → ids of every other fixture whose channels it overlaps.
 * Fixtures without an address are simply absent.
 *
 * Sorting by universe then start lets this stop comparing as soon as a
 * later fixture starts past the current one's end, so a 500-fixture rig
 * doesn't cost 250,000 comparisons on every keystroke.
 */
export const findAddressConflicts = (fixtures: Fixture[]): Map<string, string[]> => {
  const ranged = fixtures
    .map((fixture) => ({ fixture, range: fixtureRange(fixture) }))
    .filter((entry): entry is { fixture: Fixture; range: AddressRange } => entry.range !== null)
    .sort((a, b) => a.range.universe - b.range.universe || a.range.start - b.range.start)

  const conflicts = new Map<string, string[]>()
  const add = (id: string, other: string) => {
    const existing = conflicts.get(id)
    if (existing) existing.push(other)
    else conflicts.set(id, [other])
  }

  for (let i = 0; i < ranged.length; i++) {
    for (let j = i + 1; j < ranged.length; j++) {
      const a = ranged[i]!
      const b = ranged[j]!
      // Sorted, so once b starts past a's end nothing later can overlap a.
      if (b.range.universe !== a.range.universe || b.range.start > a.range.end) break
      if (overlaps(a.range, b.range)) {
        add(a.fixture.id, b.fixture.id)
        add(b.fixture.id, a.fixture.id)
      }
    }
  }
  return conflicts
}

/**
 * Fixtures whose footprint runs off the end of their universe. A 32-channel
 * head patched at 500 needs channels 500–531, and 513 onwards doesn't exist.
 */
export const findOverruns = (fixtures: Fixture[]): string[] =>
  fixtures
    .filter((fixture) => {
      const range = fixtureRange(fixture)
      return range !== null && range.end > DMX_UNIVERSE_SIZE
    })
    .map((fixture) => fixture.id)

export interface UniverseUsage {
  universe: number
  /** Channels occupied by at least one fixture. */
  used: number
  free: number
  fixtureCount: number
  /** Free runs of channels, largest first — where a new fixture could go. */
  gaps: { start: number; end: number }[]
}

/** Per-universe occupancy, for the "how full is my rig" summary. */
export const universeUsage = (fixtures: Fixture[]): UniverseUsage[] => {
  const byUniverse = new Map<number, AddressRange[]>()
  for (const fixture of fixtures) {
    const range = fixtureRange(fixture)
    if (!range) continue
    const list = byUniverse.get(range.universe)
    if (list) list.push(range)
    else byUniverse.set(range.universe, [range])
  }

  return [...byUniverse.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([universe, ranges]) => {
      // Union the ranges so overlapping fixtures don't double-count usage.
      // Ranges starting past the end of the universe are nonsense an import
      // can carry in; findOverruns reports them, and counting them here
      // would produce a negative-length run.
      const sorted = [...ranges]
        .filter((range) => range.start <= DMX_UNIVERSE_SIZE)
        .sort((a, b) => a.start - b.start)
      const merged: { start: number; end: number }[] = []
      for (const range of sorted) {
        const end = Math.min(range.end, DMX_UNIVERSE_SIZE)
        const last = merged[merged.length - 1]
        if (last && range.start <= last.end + 1) last.end = Math.max(last.end, end)
        else merged.push({ start: range.start, end })
      }

      const used = merged.reduce((sum, run) => sum + (run.end - run.start + 1), 0)
      const gaps: { start: number; end: number }[] = []
      let cursor = 1
      for (const run of merged) {
        if (run.start > cursor) gaps.push({ start: cursor, end: run.start - 1 })
        cursor = run.end + 1
      }
      if (cursor <= DMX_UNIVERSE_SIZE) gaps.push({ start: cursor, end: DMX_UNIVERSE_SIZE })

      return {
        universe,
        used,
        free: DMX_UNIVERSE_SIZE - used,
        fixtureCount: ranges.length,
        gaps: gaps.sort((a, b) => b.end - b.start - (a.end - a.start)),
      }
    })
}

/**
 * The lowest address in `universe` where `footprint` channels fit without
 * touching anything already patched — "put this somewhere it works", which
 * is what you want when adding a fixture on site. Null if the universe is
 * too full.
 *
 * `ignoreId` excludes a fixture from consideration so re-addressing an
 * existing fixture doesn't collide with its own current position.
 */
export const nextFreeAddress = (
  fixtures: Fixture[],
  universe: number,
  footprint: number,
  ignoreId?: string
): number | null => {
  if (footprint <= 0 || footprint > DMX_UNIVERSE_SIZE) return null
  const occupied = fixtures
    .filter((fixture) => fixture.id !== ignoreId)
    .map(fixtureRange)
    .filter((range): range is AddressRange => range !== null && range.universe === universe)
    .sort((a, b) => a.start - b.start)

  let cursor = 1
  for (const range of occupied) {
    if (range.start - cursor >= footprint) return cursor
    cursor = Math.max(cursor, range.end + 1)
  }
  return cursor + footprint - 1 <= DMX_UNIVERSE_SIZE ? cursor : null
}

/**
 * Parse the address notations that turn up in console and paperwork
 * exports: a bare number (absolute across universes, so 537 is universe 2
 * address 25), or an explicit `universe/address` or `universe.address`.
 *
 * Returns null for anything unparseable rather than guessing — a wrong
 * address is worse than a blank one.
 */
export const parseAddress = (text: string): { universe: number; address: number } | null => {
  const trimmed = text.trim()
  if (!trimmed) return null

  const split = /^(\d+)\s*[/.:]\s*(\d+)$/.exec(trimmed)
  if (split) {
    const universe = Number(split[1])
    const address = Number(split[2])
    if (universe < 1 || address < 1 || address > DMX_UNIVERSE_SIZE) return null
    return { universe, address }
  }

  if (!/^\d+$/.test(trimmed)) return null
  const absolute = Number(trimmed)
  if (absolute < 1) return null
  return {
    universe: Math.floor((absolute - 1) / DMX_UNIVERSE_SIZE) + 1,
    address: ((absolute - 1) % DMX_UNIVERSE_SIZE) + 1,
  }
}

/** Display form, e.g. `2/25`. */
export const formatAddress = (universe: number, address: number): string =>
  address > 0 ? `${universe}/${address}` : ''
