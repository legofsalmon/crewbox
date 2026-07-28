import type { ImportedSheetData } from './sheetDoc'
import type { PatchField } from './types'

/**
 * Reading the patch sheet a festival actually keeps.
 *
 * The shape crews build in Google Sheets is not one header row and then data.
 * It is a title, a colour legend for the sub-snakes, a day, then a *two-tier*
 * header — act names spanning three columns each, and under them CH /
 * SUB-BOX / MIC-DI repeating once per act — with the house input list down
 * the left and repeated down the right so you can read across from either
 * side.
 *
 * The generic importer sees eight rows of preamble and gives up: it reads the
 * title row as the header and produces one artist called "Artist 1" and a
 * hundred empty channels. This reads the real thing.
 *
 * Nothing here is specific to one festival. It looks for the structure — a
 * CH/INPUT pair followed by repeating CH/SUB-BOX/MIC groups — rather than for
 * particular words in particular cells.
 */

const norm = (cell: string | undefined): string =>
  (cell ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** Cells per act in the repeating block: its own channel, sub-box, mic/DI. */
const GROUP_WIDTH = 3

interface Layout {
  headerRow: number
  /** Column index where each act's group of three starts. */
  groups: number[]
}

/**
 * Find the header row and the act columns under it.
 *
 * The signature is a channel column, an input column, and then at least one
 * run of three that reads channel / sub-box / mic. One act is enough — a
 * single-act sheet in this layout is still this layout.
 */
function findLayout(rows: string[][]): Layout | null {
  const limit = Math.min(rows.length, 40)
  for (let r = 0; r < limit; r++) {
    const row = rows[r]!
    if (norm(row[0]) !== 'ch' || !norm(row[1]).includes('input')) continue
    const groups: number[] = []
    for (let c = 2; c + GROUP_WIDTH - 1 < row.length; c += GROUP_WIDTH) {
      const isGroup =
        norm(row[c]) === 'ch' &&
        (norm(row[c + 1]).includes('sub') || norm(row[c + 1]).includes('box')) &&
        (norm(row[c + 2]).includes('mic') || norm(row[c + 2]).includes('di'))
      if (!isGroup) break
      groups.push(c)
    }
    if (groups.length > 0) return { headerRow: r, groups }
  }
  return null
}

/** Is this the row of act names, rather than the set times or the spec line? */
const looksLikeTimes = (cell: string): boolean =>
  norm(cell).includes('startend') || /\d\s*[-–]\s*\d/.test(cell)

const looksLikeSpec = (cell: string): boolean => norm(cell).startsWith('spec')

/**
 * The act names, set times and spec lines above the header.
 *
 * Walk up from the header. A row whose first act cell reads like a set time
 * or a spec label is that; the first row above them with anything in it is
 * the names. Blank template placeholders ("Start - End", "SPEC:") are read as
 * empty, because that is what they are — nobody typed a set time yet.
 */
function readActHeaders(
  rows: string[][],
  layout: Layout
): Array<{ name: string; startTime?: string; endTime?: string; spec?: string }> {
  let nameRow: string[] | null = null
  let timesRow: string[] | null = null
  let specRow: string[] | null = null

  for (let r = layout.headerRow - 1; r >= 0; r--) {
    const row = rows[r]!
    const probe = layout.groups.map((c) => row[c + 1] ?? '').find((cell) => cell.trim() !== '')
    if (probe === undefined) continue
    if (looksLikeSpec(probe)) {
      specRow ??= row
    } else if (looksLikeTimes(probe)) {
      timesRow ??= row
    } else {
      nameRow = row
      break
    }
  }

  return layout.groups.map((c, i) => {
    const raw = (timesRow?.[c + 1] ?? '').trim()
    // "19:00 - 20:00" is a set time; "Start - End" is the empty template.
    const times = /(\d{1,2}[:.]\d{2})\s*[-–]\s*(\d{1,2}[:.]\d{2})/.exec(raw)
    const spec = (specRow?.[c + 1] ?? '').trim()
    return {
      name: (nameRow?.[c + 1] ?? '').trim() || `Artist ${i + 1}`,
      ...(times
        ? { startTime: times[1].replace('.', ':'), endTime: times[2].replace('.', ':') }
        : {}),
      ...(looksLikeSpec(spec) ? {} : { spec }),
    }
  })
}

/** Common gaffer-tape colours, so an imported box arrives the right colour. */
const COLOUR_NAMES: Record<string, string> = {
  pink: '#e91e8c',
  blue: '#3b7dd8',
  green: '#3f9e4d',
  orange: '#e8770a',
  yellow: '#d6b400',
  red: '#d3392b',
  purple: '#8e44ad',
  black: '#444444',
  white: '#cfcfcf',
  grey: '#8a8a8a',
  gray: '#8a8a8a',
  brown: '#7a5240',
}

const DEFAULT_SUB_BOX_COLOUR = '#8a8a8a'

/**
 * The sub-snake legend: a name, a channel count, and where it lives on stage.
 *
 * Found by shape — text, a plausible input count, a short position code —
 * rather than by column, because it is parked in whatever corner of the sheet
 * had room. Two rows are required before it is believed, so a stray
 * "Kick 12 USC" somewhere in the preamble can't invent a sub-box on its own.
 */
function readSubBoxLegend(
  rows: string[][],
  headerRow: number
): Array<{ name: string; inputs: number; color: string; stagePosition: string }> {
  const found: Array<{ name: string; inputs: number; color: string; stagePosition: string }> = []
  for (let r = 0; r < headerRow; r++) {
    const row = rows[r]!
    for (let c = 0; c + 2 < row.length; c++) {
      const name = (row[c] ?? '').trim()
      const count = Number((row[c + 1] ?? '').trim())
      const position = (row[c + 2] ?? '').trim()
      const plausible =
        name.length > 0 &&
        name.length <= 24 &&
        Number.isInteger(count) &&
        count >= 1 &&
        count <= 64 &&
        position.length > 0 &&
        position.length <= 8 &&
        !position.includes(' ')
      if (!plausible) continue
      found.push({
        name: name.toUpperCase(),
        inputs: count,
        color: COLOUR_NAMES[name.toLowerCase()] ?? DEFAULT_SUB_BOX_COLOUR,
        stagePosition: position.toUpperCase(),
      })
      break
    }
  }
  return found.length >= 2 ? found : []
}

export interface FestivalImport {
  data: ImportedSheetData
  /** Set when the file isn't in this layout at all. */
  matched: boolean
}

/**
 * Parse a festival master patch sheet.
 *
 * Returns `matched: false` when the layout isn't there, so the caller can
 * fall back to the generic importer rather than this guessing.
 */
export function festivalSheetFromCsv(rows: string[][]): FestivalImport {
  const layout = findLayout(rows)
  if (!layout) return { data: { channels: [], artists: [], patches: [] }, matched: false }

  const artists = readActHeaders(rows, layout)
  const subBoxes = readSubBoxLegend(rows, layout.headerRow)

  // Data runs until the channel numbers stop. Below them sit the "Additional
  // info" boxes and the per-act tail tables, which are not channels.
  const channels: Array<{ label: string; input: string }> = []
  const dataRows: string[][] = []
  for (let r = layout.headerRow + 1; r < rows.length; r++) {
    const row = rows[r]!
    const label = (row[0] ?? '').trim()
    if (!/^\d+$/.test(label)) break
    channels.push({ label, input: (row[1] ?? '').trim() })
    dataRows.push(row)
  }

  const patches: ImportedSheetData['patches'] = layout.groups.map((c) =>
    dataRows.map((row) => {
      const entry: Partial<Record<PatchField, string>> = {}
      const subBox = (row[c + 1] ?? '').trim()
      const micDi = (row[c + 2] ?? '').trim()
      if (subBox) entry.subBox = subBox
      if (micDi) entry.micDi = micDi
      return Object.keys(entry).length > 0 ? entry : undefined
    })
  )

  return {
    data: { channels, artists, subBoxes, patches },
    matched: channels.length > 0,
  }
}
