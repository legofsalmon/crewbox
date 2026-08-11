import { formatChangeover, gapBetween, parseChangeover } from './changeover'
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
 * title row as the header and produces one act called "Act 1" and a
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
): {
  acts: Array<{
    name: string
    start?: string
    end?: string
    changeover: number
    spec?: string
    notes?: string
  }>
  /** What the sheet literally said, per act, before anything was derived. */
  written: Array<number | null>
} {
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

  const acts = layout.groups.map((c, i) => {
    const raw = (timesRow?.[c + 1] ?? '').trim()
    // "19:00 - 20:00" is a set time; "Start - End" is the empty template.
    const times = /(\d{1,2}[:.]\d{2})\s*[-–]\s*(\d{1,2}[:.]\d{2})/.exec(raw)
    const spec = (specRow?.[c + 1] ?? '').trim()
    return {
      name: (nameRow?.[c + 1] ?? '').trim() || `Act ${i + 1}`,
      ...(times ? { start: times[1].replace('.', ':'), end: times[2].replace('.', ':') } : {}),
      ...(looksLikeSpec(spec) ? {} : { spec }),
      /**
       * The narrow column to the left of an act's name carries the
       * changeover into that act — "45", "HR". It reads as sitting between
       * the two acts, and it belongs to the one it comes before.
       */
      changeover: parseChangeover(nameRow?.[c] ?? '') ?? 0,
    }
  })

  // Keep what was literally written before filling any of it in, so the
  // cross-check below compares the sheet against the sheet.
  const written = acts.map((act) => (act.changeover > 0 ? act.changeover : null))

  // Where nobody wrote one, the set times already know it. Where somebody
  // did, the two should agree — see `changeoverWarnings`.
  for (let i = 1; i < acts.length; i++) {
    const previous = acts[i - 1]!
    const act = acts[i]!
    if (act.changeover > 0 || !previous.end || !act.start) continue
    act.changeover = gapBetween(previous.end, act.start) ?? 0
  }

  return { acts, written }
}

/**
 * Where the written changeover and the running order disagree.
 *
 * Both are typed by hand into the same sheet, so one of them drifts the
 * moment a set time moves and nobody updates the other. The sheet then looks
 * authoritative and is quietly lying about the one number the day runs on.
 *
 * This says so rather than picking a winner: which is right depends on
 * whether the times moved or the changeover did, and only the person holding
 * the running order knows that.
 */
export function changeoverWarnings(
  acts: Array<{ name: string; start?: string; end?: string; changeover: number }>,
  written: Array<number | null>
): string[] {
  const out: string[] = []
  for (let i = 1; i < acts.length; i++) {
    const stated = written[i]
    const previous = acts[i - 1]!
    const act = acts[i]!
    if (!stated || !previous.end || !act.start) continue
    const derived = gapBetween(previous.end, act.start)
    if (derived === null || derived === stated) continue
    out.push(
      `${act.name}: sheet says a ${formatChangeover(stated)} changeover, ` +
        `but the set times leave ${formatChangeover(derived)}`
    )
  }
  return out
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

/**
 * Everything an act carries that lives *below* the channel grid.
 *
 * `readActHeaders` walks up from the header row and so can only ever see the
 * name, the set time and the SPEC line. The rest of what a crew writes about
 * an act is underneath the channels: a free-text "Additional info" box, and a
 * NO./ITEM table of kit they want from the house.
 *
 * Both are real production information — "require 3 57s from house", "5 tall
 * stands" — and both were being read as "not a channel row" and dropped. The
 * sheet already keeps a `notes` field per act with a textarea bound to it;
 * this fills it.
 */
function readActFooters(rows: string[][], layout: Layout, firstRowBelowData: number): string[] {
  const info = layout.groups.map(() => '')
  const items = layout.groups.map<string[]>(() => [])

  for (let r = firstRowBelowData; r < rows.length; r++) {
    const row = rows[r]!
    layout.groups.forEach((c, i) => {
      // The free-text box: a label cell reading "Additional info:" and the
      // text under it. The label repeats per act, so match on the label
      // rather than on a fixed row.
      const label = norm(row[c + 1])
      if (label.startsWith('additionalinfo')) {
        const text = (rows[r + 1]?.[c + 1] ?? '').trim()
        // The template repeats a prompt in every unfilled act's box. It is
        // instructions to whoever fills the sheet in, not information about
        // the act, and copying it onto sixteen acts would be noise.
        if (text && !info[i] && !isTemplatePrompt(text)) info[i] = text
      }

      // The kit table: "NO." / "ITEM" headers, then count/name pairs.
      if (norm(row[c + 1]) === 'no' && norm(row[c + 2]) === 'item') {
        for (let k = r + 1; k < rows.length; k++) {
          const count = (rows[k]?.[c + 1] ?? '').trim()
          const item = (rows[k]?.[c + 2] ?? '').trim()
          if (!count && !item) {
            // One blank row inside the table is a gap; two is the end of it.
            const next = rows[k + 1]
            if (!next || (!(next[c + 1] ?? '').trim() && !(next[c + 2] ?? '').trim())) break
            continue
          }
          if (item) items[i]!.push(count ? `${count} × ${item}` : item)
        }
      }
    })
  }

  return layout.groups.map((_, i) =>
    [info[i], items[i]!.length > 0 ? `Kit from house: ${items[i]!.join(', ')}` : '']
      .filter(Boolean)
      .join('\n\n')
  )
}

/**
 * A prompt the template puts in every act's box, rather than a note about
 * one act.
 *
 * The real sheet repeats "Touring Desks / Multis / Power / Other info to
 * speed up changeover from their specs" across every act nobody has filled
 * in yet. Importing that would put the same paragraph on twelve acts.
 */
const isTemplatePrompt = (text: string): boolean =>
  /other info|their specs|speed up changeover/i.test(text)

export interface FestivalImport {
  data: ImportedSheetData
  /** Set when the file isn't in this layout at all. */
  matched: boolean
  /** Things worth telling whoever ran the import. Never fatal. */
  warnings: string[]
}

/**
 * Parse a festival master patch sheet.
 *
 * Returns `matched: false` when the layout isn't there, so the caller can
 * fall back to the generic importer rather than this guessing.
 */
export function festivalSheetFromCsv(rows: string[][]): FestivalImport {
  const layout = findLayout(rows)
  if (!layout) {
    return { data: { channels: [], acts: [], patches: [] }, matched: false, warnings: [] }
  }

  const { acts, written } = readActHeaders(rows, layout)
  const subBoxes = readSubBoxLegend(rows, layout.headerRow)

  // Data runs until the channel numbers stop. Below them sit the "Additional
  // info" boxes and the per-act tail tables, which are not channels.
  const channels: Array<{ label: string; input: string }> = []
  const dataRows: string[][] = []
  let belowData = rows.length
  for (let r = layout.headerRow + 1; r < rows.length; r++) {
    const row = rows[r]!
    const label = (row[0] ?? '').trim()
    if (!/^\d+$/.test(label)) {
      belowData = r
      break
    }
    channels.push({ label, input: (row[1] ?? '').trim() })
    dataRows.push(row)
  }

  const footers = readActFooters(rows, layout, belowData)
  for (const [i, act] of acts.entries()) {
    if (footers[i]) act.notes = footers[i]!
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
    data: { channels, acts, subBoxes, patches },
    matched: channels.length > 0,
    warnings: changeoverWarnings(acts, written),
  }
}
