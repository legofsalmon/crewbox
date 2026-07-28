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
