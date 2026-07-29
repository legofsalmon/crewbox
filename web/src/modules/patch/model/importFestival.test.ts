import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { parseCsv } from '../../_shared/csv'
import { sheetFromCsv } from './importCsv'
import { festivalSheetFromCsv } from './importFestival'
import { buildImportedSheet, snapshotSheet } from './sheetDoc'
import { stagePatchFor } from './stagePatch'

/**
 * The real thing, structurally: a festival master patch exported from Google
 * Sheets. Act names and the event are invented — the layout, the sub-snake
 * legend, the house input list and the cell conventions are exactly as a crew
 * keeps them, which is the part the parser has to survive.
 */
const REAL_SHEET = readFileSync(
  fileURLToPath(new URL('./__fixtures__/festival-master-patch.csv', import.meta.url)),
  'utf8'
)

const rows = () => parseCsv(REAL_SHEET)

describe('a festival master patch sheet', () => {
  it('finds every act under the two-tier header', () => {
    const { data } = festivalSheetFromCsv(rows())
    expect(data.artists.map((a) => a.name)).toEqual([
      'THE HARBOUR LIGHTS',
      'MARGOT DUNN',
      'FALSE ECONOMY',
      'KESTREL',
      'NINE BELOW',
      'ACT 6',
      'ACT 7',
    ])
  })

  it('reads the house input list off the left column', () => {
    const { data } = festivalSheetFromCsv(rows())
    expect(data.channels).toHaveLength(56)
    expect(data.channels[0]).toEqual({ label: '1', input: 'KICK IN' })
    expect(data.channels[27]).toEqual({ label: '28', input: 'BACK VOX 4' })
    // The blank tail of the sheet is still channels — 29–56 exist on the desk.
    expect(data.channels[55]).toEqual({ label: '56', input: '' })
  })

  it('builds the sub-snakes from the colour legend', () => {
    const { data } = festivalSheetFromCsv(rows())
    expect(data.subBoxes).toEqual([
      { name: 'PINK', inputs: 12, color: '#e91e8c', stagePosition: 'USC' },
      { name: 'BLUE', inputs: 12, color: '#3b7dd8', stagePosition: 'FLOAT' },
      { name: 'GREEN', inputs: 12, color: '#3f9e4d', stagePosition: 'MSL' },
      { name: 'ORANGE', inputs: 12, color: '#e8770a', stagePosition: 'MSR' },
      { name: 'YELLOW', inputs: 12, color: '#d6b400', stagePosition: 'DSC' },
    ])
  })

  it('keeps each act’s sub-box and mic against the right channel', () => {
    const { data } = festivalSheetFromCsv(rows())
    // Act 2 mics the kick with a Beyer; act 1 doesn't mic it at all.
    expect(data.patches[1]?.[0]).toEqual({ subBox: 'BSNAKE 1', micDi: 'BEYER' })
    expect(data.patches[0]?.[0]).toEqual({ subBox: 'BSNAKE 1', micDi: '/' })
    // Acts with an empty column stay empty rather than inheriting anything.
    expect(data.patches[5]?.filter(Boolean)).toHaveLength(0)
  })

  it('is what sheetFromCsv picks for this file', () => {
    // The generic path used to read the title row as the header and produce
    // one artist and a hundred empty channels.
    const { data } = sheetFromCsv(rows())
    expect(data.artists).toHaveLength(7)
    expect(data.channels).toHaveLength(56)
  })
})

describe('not a festival sheet', () => {
  it('leaves an ordinary one-header CSV to the generic importer', () => {
    const csv = ['Channel,Input,Mic/DI', '1,Kick,D6', '2,Snare,SM57'].join('\n')
    expect(festivalSheetFromCsv(parseCsv(csv)).matched).toBe(false)
    expect(sheetFromCsv(parseCsv(csv)).data.artists).toHaveLength(1)
  })

  it('does not invent sub-boxes from one stray legend-shaped row', () => {
    const csv = [
      'Some Title,,,,SPARE,8,USC',
      'CH,INPUT,CH,SUB-BOX,MIC / DI:',
      '1,Kick,1,PINK 1,D6',
    ].join('\n')
    expect(festivalSheetFromCsv(parseCsv(csv)).data.subBoxes).toEqual([])
  })
})

describe('the whole way through', () => {
  it('imports, stores, and reads back as a stage patch', () => {
    const doc = new Y.Doc()
    buildImportedSheet(doc, sheetFromCsv(rows()).data, { title: 'Riverside' })
    const snapshot = snapshotSheet(doc)

    const act = snapshot.artists[1]!
    expect(act.name).toBe('MARGOT DUNN')

    const runs = stagePatchFor(snapshot, act.id)
    const bsnake = runs.find((r) => r.name === 'BSNAKE')!
    // "BSNAKE 1" in a cell became box BSNAKE, tail 1 — and from the stage end
    // that tail carries the house input on channel 1.
    expect(bsnake.rows[0].tail).toBe(1)
    expect(bsnake.rows[0].channel?.label).toBe('1')
    expect(bsnake.rows[0].input).toBe('KICK IN')
    expect(bsnake.rows[0].micDi).toBe('BEYER')
    expect(bsnake.used).toBe(8)

    // The declared sub-snakes are there too, empty, because this sheet's
    // cells name the band snakes rather than the colours.
    const pink = runs.find((r) => r.name === 'PINK')!
    expect(pink.rows).toHaveLength(12)
    expect(pink.used).toBe(0)
    expect(pink.stagePosition).toBe('USC')
  })

  it('does not make every act retype the input list', () => {
    const doc = new Y.Doc()
    buildImportedSheet(doc, sheetFromCsv(rows()).data, { title: 'Riverside' })
    const snapshot = snapshotSheet(doc)
    // The house input lives once, on the channel.
    expect(snapshot.channels[0]!.input).toBe('KICK IN')
    for (const artist of snapshot.artists) {
      const entry = snapshot.patches[`${artist.id}:${snapshot.channels[0]!.id}`]
      expect(entry?.input ?? '').toBe('')
    }
  })
})

/**
 * A second real sheet, from a different stage.
 *
 * The parser was shaped against one file, which is one file's worth of
 * evidence about a layout crews build by hand. This is another export of the
 * same shape and it carries three things the first one does not: a five-way
 * sub-snake legend, per-act "Additional info" boxes with real text in them,
 * and a NO./ITEM table of kit an act wants from the house.
 *
 * Act names and the event are invented; the structure is untouched.
 */
const DAY_SHEET = readFileSync(
  fileURLToPath(new URL('./__fixtures__/festival-day-sheet.csv', import.meta.url)),
  'utf8'
)

const dayRows = () => parseCsv(DAY_SHEET)

describe('a second sheet, from a different stage', () => {
  it('reads it without being told anything new', () => {
    const { data, matched } = festivalSheetFromCsv(dayRows())
    expect(matched).toBe(true)
    expect(data.channels).toHaveLength(56)
    expect(data.channels[0]).toEqual({ label: '1', input: 'KICK IN' })
    expect(data.channels[47]).toEqual({ label: '48', input: 'HH4' })
  })

  it('separates the acts somebody booked from the empty template slots', () => {
    const { data } = festivalSheetFromCsv(dayRows())
    expect(data.artists).toHaveLength(16)
    expect(data.artists.slice(0, 4).map((a) => a.name)).toEqual([
      'Copper Wren',
      'Tin Chapel',
      'The Ledger',
      'Salt Harbour',
    ])
    // The rest are the sheet's own placeholders, kept so the columns line up
    // with the paper everyone is holding.
    expect(data.artists[4]!.name).toBe('ACT 5')
    expect(data.artists[4]!.startTime).toBeUndefined()
  })

  it('takes the set times off the acts that have them', () => {
    const { data } = festivalSheetFromCsv(dayRows())
    expect(data.artists[0]).toMatchObject({ startTime: '17:00', endTime: '18:00' })
    // A set running past midnight is a set, not a parse failure.
    expect(data.artists[3]).toMatchObject({ startTime: '22:45', endTime: '00:15' })
  })

  it('reads all five sub-snakes, with their colour and where they live', () => {
    const { data } = festivalSheetFromCsv(dayRows())
    expect(data.subBoxes).toEqual([
      { name: 'PINK', inputs: 12, color: '#e91e8c', stagePosition: 'USC' },
      { name: 'BLUE', inputs: 12, color: '#3b7dd8', stagePosition: 'FLOAT' },
      { name: 'GREEN', inputs: 12, color: '#3f9e4d', stagePosition: 'MSL' },
      { name: 'ORANGE', inputs: 12, color: '#e8770a', stagePosition: 'MSR' },
      { name: 'YELLOW', inputs: 12, color: '#d6b400', stagePosition: 'DSC' },
    ])
  })

  it('keeps the Additional info box, which used to be thrown away', () => {
    // This sits *below* the channel grid, so the header reader never saw it
    // and the channel reader stopped at it. It is where a crew writes the
    // things that decide the changeover.
    const { data } = festivalSheetFromCsv(dayRows())
    expect(data.artists[0]!.notes).toBe('Pray for the end of the set')
    expect(data.artists[1]!.notes).toBe('DL32 / ALL ON HOUSE BAR FOH')
    expect(data.artists[2]!.notes).toContain('Require 3 57s from House')
  })

  it('picks up the kit an act wants from the house', () => {
    const { data } = festivalSheetFromCsv(dayRows())
    expect(data.artists[2]!.notes).toContain('Kit from house: 5 × Tall Stands, 12 × Small Stands')
  })

  it('does not copy the template prompt onto every unbooked act', () => {
    // Every empty act's box repeats "Touring Desks / Multis / Power / Other
    // info to speed up changeover from their specs". That is instructions to
    // whoever fills the sheet in, and putting it on twelve acts would bury
    // the three notes that mean something.
    const { data } = festivalSheetFromCsv(dayRows())
    for (const artist of data.artists.slice(4)) {
      expect(artist.notes ?? '').toBe('')
    }
    expect(data.artists[3]!.notes ?? '').toBe('')
  })

  it('carries the sub-box letters the grid actually uses', () => {
    // This stage writes a bare "H" on the handheld channels rather than the
    // "SB1-1" style of the other sheet. Both are just text to the parser,
    // which is the point — nothing here knows one festival's convention.
    const { data } = festivalSheetFromCsv(dayRows())
    const first = data.patches[0]!
    expect(first[44]).toEqual({ subBox: 'H' })
    expect(first[46]).toEqual({ subBox: 'H', micDi: 'LEAD 1' })
    expect(first[0]).toEqual({ micDi: 'VIOLIN-1-1 4099' })
  })
})

describe('what actually lands in the document', () => {
  it('carries the Additional info all the way into the sheet', () => {
    // The parse producing notes is only half of it: `buildImportedSheet` used
    // to write an empty string over them, so a crew importing this sheet got
    // a blank Additional info box on every act and no sign anything was lost.
    const doc = new Y.Doc()
    buildImportedSheet(doc, festivalSheetFromCsv(dayRows()).data, { title: 'Day 1' })
    const snapshot = snapshotSheet(doc)
    expect(snapshot.artists[0]!.notes).toBe('Pray for the end of the set')
    expect(snapshot.artists[2]!.notes).toContain('Kit from house:')
    expect(snapshot.artists[4]!.notes).toBe('')
  })
})

describe('the changeover between two acts', () => {
  it('reads the cell in the narrow column beside each act name', () => {
    // "45" on the second act, "HR" on the third and fourth. The value in an
    // act's column is the gap *into* that act — it reads as sitting between
    // the two, and the sheet's own set times agree on all three.
    const { data } = festivalSheetFromCsv(dayRows())
    expect(data.artists.slice(0, 4).map((a) => a.changeover)).toEqual([0, 45, 60, 60])
  })

  it('leaves the first act of the day without one', () => {
    // There is no act before it to change over from.
    expect(festivalSheetFromCsv(dayRows()).data.artists[0]!.changeover).toBe(0)
  })

  it('works it out from the set times where nobody wrote one', () => {
    const rows = dayRows()
    // Blank the "45" cell: the times still say 18:00 → 18:45.
    rows[5]![5] = ''
    expect(festivalSheetFromCsv(rows).data.artists[1]!.changeover).toBe(45)
  })

  it('says nothing rather than guessing when neither is there', () => {
    const { data } = festivalSheetFromCsv(dayRows())
    // The empty template slots have no times and no changeover cell.
    expect(data.artists[6]!.changeover).toBe(0)
  })

  it('flags a written changeover that disagrees with the running order', () => {
    // The number a day is planned around, typed twice in the same sheet.
    // Move a set time and the changeover beside it is quietly stale — this
    // is what says so, and it names both figures rather than picking one.
    const rows = dayRows()
    rows[5]![5] = '30'
    const { warnings } = festivalSheetFromCsv(rows)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Tin Chapel')
    expect(warnings[0]).toContain('30 min')
    expect(warnings[0]).toContain('45 min')
  })

  it('stays quiet when the sheet agrees with itself', () => {
    expect(festivalSheetFromCsv(dayRows()).warnings).toEqual([])
  })

  it('carries the changeover into the document', () => {
    const doc = new Y.Doc()
    buildImportedSheet(doc, festivalSheetFromCsv(dayRows()).data, { title: 'Day 1' })
    expect(
      snapshotSheet(doc)
        .artists.slice(0, 4)
        .map((a) => a.changeover)
    ).toEqual([0, 45, 60, 60])
  })
})
