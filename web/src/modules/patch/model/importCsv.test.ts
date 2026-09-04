import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { parseCsv, parseTsv, sheetToCsv } from './csv'
import { sheetFromCsv } from './importCsv'
import {
  addSubBox,
  buildImportedSheet,
  initSheet,
  setPatchField,
  setPatchSubBox,
  snapshotSheet,
} from './sheetDoc'
import { sheetActs } from './lineup'
import { patchKey } from './types'
import { addAct, snapshotTimetable, updateAct } from '../../../shell/timetable/model.ts'

describe('parseDelimited', () => {
  it('parses plain CSV with CRLF and a BOM', () => {
    expect(parseCsv('\uFEFFa,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('honours quoted fields containing delimiters, quotes, and newlines', () => {
    expect(parseCsv('"a,1","say ""hi""","line1\nline2"')).toEqual([
      ['a,1', 'say "hi"', 'line1\nline2'],
    ])
  })

  it('parses Google Sheets clipboard TSV', () => {
    expect(parseTsv('Kick\tSM91\nSnare\tSM57\n')).toEqual([
      ['Kick', 'SM91'],
      ['Snare', 'SM57'],
    ])
    expect(parseTsv('a\t"multi\nline"\tb')).toEqual([['a', 'multi\nline', 'b']])
  })
})

describe('sheetFromCsv', () => {
  it('round-trips crewbox’s own export, act names and all', () => {
    const doc = new Y.Doc()
    const events = new Y.Doc()
    initSheet(doc, { title: 'RT', date: '2026-07-24', channelCount: 2 })
    addAct(events, { name: 'Act 1', stage: 'RT', date: '2026-07-24' })
    const snap0 = snapshotSheet(doc)
    const act = snapshotTimetable(events).acts[0]!.id
    updateAct(events, act, { name: 'Headliner' })
    addSubBox(doc, { name: 'Box 1', stagePosition: 'MSC' })
    setPatchSubBox(doc, act, snap0.channels[0].id, 'Box 1')
    setPatchField(doc, act, snap0.channels[0].id, 'input', 'Kick, low')
    setPatchField(doc, act, snap0.channels[1].id, 'micDi', 'SM57')

    const csv = sheetToCsv(
      snapshotSheet(doc),
      sheetActs(snapshotSheet(doc), snapshotTimetable(events).acts)
    )
    const { data, skippedColumns } = sheetFromCsv(parseCsv(csv))

    expect(skippedColumns).toEqual([])
    expect(data.acts.map((a) => a.name)).toEqual(['Headliner'])
    expect(data.channels).toHaveLength(2)
    expect(data.patches[0][0]).toMatchObject({ subBox: 'Box 1 (MSC)', input: 'Kick, low' })
    expect(data.patches[0][1]).toMatchObject({ micDi: 'SM57' })
  })

  it('maps a generic Google Sheets patch via fuzzy headers', () => {
    const rows = parseCsv(
      [
        'Ch,Instrument,Description,Mic / DI,Stand,48V',
        '1,Kick,Kick in,Beta 91A,Short Boom,Yes',
        '2,Snare,,SM57,Clip-on,',
        ',,,,,',
      ].join('\n')
    )
    const { data, skippedColumns } = sheetFromCsv(rows)

    expect(skippedColumns).toEqual(['48V'])
    expect(data.acts).toHaveLength(1)
    expect(data.channels.map((c) => c.label)).toEqual(['1', '2'])
    expect(data.patches[0][0]).toMatchObject({
      input: 'Kick',
      description: 'Kick in',
      micDi: 'Beta 91A',
      stand: 'Short Boom',
    })
    expect(data.patches[0][1]).toMatchObject({ input: 'Snare', micDi: 'SM57' })
  })

  it('numbers channels when no channel column exists', () => {
    const { data } = sheetFromCsv(parseCsv('Input,Mic\nVocals,SM58\nKeys,DI'))
    expect(data.channels.map((c) => c.label)).toEqual(['1', '2'])
  })
})

describe('buildImportedSheet', () => {
  it('creates a working doc, and puts the acts on the running order', () => {
    const doc = new Y.Doc()
    const events = new Y.Doc()
    buildImportedSheet(
      doc,
      events,
      {
        channels: [{ label: 'Kick' }, { label: '2' }],
        acts: [{ name: 'Band A', start: '19:00', spec: '5 piece' }],
        patches: [[{ input: 'Kick', micDi: 'Beta 91A' }, undefined]],
      },
      { title: 'Imported', date: '2026-07-24', now: '2026-07-24T10:00:00.000Z' }
    )
    const snap = snapshotSheet(doc)
    expect(snap.meta.title).toBe('Imported')
    expect(snap.channels.map((c) => c.label)).toEqual(['Kick', '2'])

    // Importing a patch sheet is how the box learns the day's running order.
    const [act] = snapshotTimetable(events).acts
    expect(act).toMatchObject({ name: 'Band A', start: '19:00', stage: 'Imported' })

    // The spec stayed with the sheet; the patch is keyed by the act's id.
    expect(snap.extras[act!.id]?.spec).toBe('5 piece')
    const entry = snap.patches[patchKey(act!.id, snap.channels[0].id)]
    expect(entry).toMatchObject({ input: 'Kick', micDi: 'Beta 91A' })

    // And the grid gets its columns back by asking the timetable.
    expect(sheetActs(snap, snapshotTimetable(events).acts).map((a) => a.name)).toEqual(['Band A'])
  })
})

describe('a file that names two slots the same', () => {
  /**
   * "Changeover" twice, "TBC" twice, a support band playing an early and a
   * late set. The upsert that reconciles a re-import with the day already on
   * the box reconciled these two rows of one file with *each other*, so the
   * sheet got one column where the file had two — and the second act's patch
   * was written straight over the first's.
   */
  it('keeps them as separate acts, and says it did', () => {
    const doc = new Y.Doc()
    const events = new Y.Doc()
    const report = buildImportedSheet(
      doc,
      events,
      {
        channels: [{ label: '1' }],
        acts: [
          { name: 'DJ set', start: '14:00' },
          { name: 'Band A', start: '16:00' },
          { name: 'DJ set', start: '23:00' },
        ],
        patches: [[{ input: 'Decks' }], [{ input: 'Kick' }], [{ input: 'CDJs' }]],
      },
      { title: 'Main', date: '2026-07-24' }
    )

    const acts = snapshotTimetable(events).acts
    expect(acts.map((a) => a.name)).toEqual(['DJ set', 'Band A', 'DJ set'])
    // Each slot kept its own start time, and its own patch.
    expect(acts[0]!.start).toBe('14:00')
    expect(acts[2]!.start).toBe('23:00')
    const snap = snapshotSheet(doc)
    const channel = snap.channels[0]!.id
    expect(snap.patches[patchKey(acts[0]!.id, channel)]?.input).toBe('Decks')
    expect(snap.patches[patchKey(acts[2]!.id, channel)]?.input).toBe('CDJs')

    expect(report.duplicateActs).toEqual(['DJ set'])
  })

  it('still reconciles with a day already on the box', () => {
    // The reason the upsert is there at all: a second sheet for the same
    // stage, or a re-import after a correction, must not list the day twice.
    const events = new Y.Doc()
    const first = new Y.Doc()
    buildImportedSheet(
      first,
      events,
      {
        channels: [{ label: '1' }],
        acts: [{ name: 'Band A', start: '19:00' }],
        patches: [[{ input: 'Kick' }]],
      },
      { title: 'Main', date: '2026-07-24' }
    )
    const second = new Y.Doc()
    const report = buildImportedSheet(
      second,
      events,
      {
        channels: [{ label: '1' }],
        acts: [{ name: 'Band A', end: '20:00' }],
        patches: [[{ input: 'Kick' }]],
      },
      { title: 'Main', date: '2026-07-24' }
    )
    const acts = snapshotTimetable(events).acts
    expect(acts).toHaveLength(1)
    // The second file said nothing about the start, so the first one stands.
    expect(acts[0]).toMatchObject({ name: 'Band A', start: '19:00', end: '20:00' })
    expect(report.duplicateActs).toEqual([])
  })
})
