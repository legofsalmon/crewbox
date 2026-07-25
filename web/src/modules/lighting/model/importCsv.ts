import { isBlankRow, normalizeHeader } from '../../_shared/csv'
import { parseAddress } from './addressing'
import { matchTypeByName } from './fixtures'
import type { Fixture, FixtureStatus, FixtureType } from './types'

/**
 * Import fixtures from lighting paperwork.
 *
 * Lightwright and the desks (Eos, grandMA, Hog) all export CSV with
 * different column names for the same handful of things, so rather than
 * pick one format this matches headers by meaning. Anything it doesn't
 * recognise is reported back rather than silently dropped — someone
 * importing a 400-fixture rig deserves to know what didn't come across.
 */

/** The things we can read out of a row. */
type ImportField =
  | 'channel'
  | 'address'
  | 'universe'
  | 'type'
  | 'mode'
  | 'footprint'
  | 'purpose'
  | 'position'
  | 'unit'
  | 'circuit'
  | 'watts'
  | 'weight'
  | 'notes'

export interface ImportedFixtureRow extends Partial<Omit<Fixture, 'id'>> {
  /** Position name from the source; resolved to an id by the caller. */
  positionName?: string
  /** Type name from the source, when it didn't match a known type. */
  typeName?: string
}

export interface ImportResult {
  fixtures: ImportedFixtureRow[]
  /** Position names seen in the source, in first-seen order. */
  positionNames: string[]
  /** Source headers that didn't map to anything. */
  skippedColumns: string[]
}

/**
 * Header synonyms, most specific first. Order matters: 'Circuit #' has to
 * beat the bare-number rule that claims '#' for unit, and 'Unit #' has to
 * beat 'universe' for 'u#'.
 */
const HEADER_RULES: { field: ImportField; test: (h: string) => boolean }[] = [
  { field: 'circuit', test: (h) => h.includes('circuit') || h === 'ckt' || h === 'cct' },
  { field: 'universe', test: (h) => h === 'universe' || h === 'uni' || h === 'univ' },
  {
    field: 'address',
    test: (h) =>
      h === 'address' || h === 'addr' || h === 'patch' || h === 'dmx' || h === 'dmxaddress',
  },
  // Lightwright calls the dimmer/address column 'Dimmer' on conventional rigs.
  { field: 'address', test: (h) => h === 'dimmer' || h === 'dim' },
  {
    field: 'channel',
    test: (h) => h === 'channel' || h === 'chan' || h === 'ch' || h === 'chan#' || h === 'channel#',
  },
  {
    field: 'footprint',
    test: (h) => h.includes('footprint') || h === 'chancount' || h === 'dmxch',
  },
  { field: 'mode', test: (h) => h === 'mode' || h === 'dmxmode' || h === 'fixturemode' },
  {
    field: 'type',
    test: (h) => h === 'type' || h === 'fixturetype' || h === 'instrumenttype' || h === 'fixture',
  },
  {
    field: 'purpose',
    test: (h) => h === 'purpose' || h === 'label' || h === 'name' || h === 'description',
  },
  { field: 'position', test: (h) => h === 'position' || h === 'pos' || h === 'location' },
  { field: 'unit', test: (h) => h === 'unit' || h === 'unit#' || h === 'u#' || h === 'unitnumber' },
  { field: 'watts', test: (h) => h.includes('watt') || h === 'power' || h === 'w' },
  { field: 'weight', test: (h) => h.includes('weight') || h === 'kg' || h === 'lbs' },
  { field: 'notes', test: (h) => h.includes('note') || h === 'remarks' || h === 'comment' },
]

const matchHeader = (header: string): ImportField | null => {
  const h = normalizeHeader(header)
  if (!h) return null
  return HEADER_RULES.find((rule) => rule.test(h))?.field ?? null
}

/** A header row is one where at least two columns mean something to us. */
const looksLikeHeader = (row: string[]): boolean =>
  row.filter((cell) => matchHeader(cell) !== null).length >= 2

const toNumber = (text: string): number | null => {
  const cleaned = text.trim().replace(/[^0-9.-]/g, '')
  if (!cleaned) return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

const STATUS_WORDS: Record<string, FixtureStatus> = {
  ok: 'ok',
  working: 'ok',
  good: 'ok',
  rigged: 'rigged',
  hung: 'rigged',
  fault: 'fault',
  dead: 'fault',
  broken: 'fault',
}

/**
 * Read fixtures out of parsed CSV rows.
 *
 * `customTypes` lets type names in the source resolve against types the plot
 * already knows, so a second import doesn't create duplicates.
 */
export const fixturesFromCsv = (rows: string[][], customTypes: FixtureType[]): ImportResult => {
  const nonEmpty = rows.filter((row) => !isBlankRow(row))
  if (nonEmpty.length === 0) return { fixtures: [], positionNames: [], skippedColumns: [] }

  // Exports often carry a title row or two before the real headers.
  const headerIndex = nonEmpty.findIndex(looksLikeHeader)
  if (headerIndex === -1) return { fixtures: [], positionNames: [], skippedColumns: [] }

  const header = nonEmpty[headerIndex]!
  const mapping = header.map(matchHeader)
  const skippedColumns = header.filter((label, i) => label.trim() !== '' && mapping[i] === null)

  const positionNames: string[] = []
  const fixtures: ImportedFixtureRow[] = []

  for (const row of nonEmpty.slice(headerIndex + 1)) {
    const cells: Partial<Record<ImportField, string>> = {}
    mapping.forEach((field, col) => {
      const value = row[col]?.trim()
      // First matching column wins when two headers mean the same thing.
      if (field && value && !cells[field]) cells[field] = value
    })
    if (Object.keys(cells).length === 0) continue

    const fixture: ImportedFixtureRow = {}

    // Address may be absolute (537), or universe-qualified (2/25, 2.25). An
    // explicit universe column overrides whatever the address implied.
    if (cells.address) {
      const parsed = parseAddress(cells.address)
      if (parsed) {
        fixture.universe = parsed.universe
        fixture.address = parsed.address
      }
    }
    if (cells.universe) {
      const universe = toNumber(cells.universe)
      if (universe !== null && universe >= 1) fixture.universe = Math.floor(universe)
    }

    if (cells.channel) fixture.channel = cells.channel
    if (cells.purpose) fixture.purpose = cells.purpose
    if (cells.unit) fixture.unit = cells.unit
    if (cells.circuit) fixture.circuit = cells.circuit
    if (cells.mode) fixture.mode = cells.mode

    if (cells.type) {
      const matched = matchTypeByName(cells.type, customTypes)
      if (matched) fixture.typeId = matched.id
      else fixture.typeName = cells.type
    }

    const footprint = cells.footprint ? toNumber(cells.footprint) : null
    if (footprint !== null && footprint > 0) fixture.footprint = Math.floor(footprint)

    const watts = cells.watts ? toNumber(cells.watts) : null
    if (watts !== null) fixture.watts = watts
    const weight = cells.weight ? toNumber(cells.weight) : null
    if (weight !== null) fixture.weight = weight

    if (cells.notes) {
      fixture.notes = cells.notes
      const status = STATUS_WORDS[normalizeHeader(cells.notes)]
      if (status) fixture.status = status
    }

    if (cells.position) {
      fixture.positionName = cells.position
      if (!positionNames.includes(cells.position)) positionNames.push(cells.position)
    }

    fixtures.push(fixture)
  }

  return { fixtures, positionNames, skippedColumns }
}
