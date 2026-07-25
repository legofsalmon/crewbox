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
  updateArtist,
} from './sheetDoc'
import { patchKey } from './types'

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
  it('round-trips Live Patch’s own export, including multiple artists', () => {
    const doc = new Y.Doc()
    initSheet(doc, { title: 'RT', date: '2026-07-24', channelCount: 2 })
    const snap0 = snapshotSheet(doc)
    const artist = snap0.artists[0].id
    updateArtist(doc, artist, { name: 'Headliner' })
    addSubBox(doc, { name: 'Box 1', stagePosition: 'MSC' })
    setPatchSubBox(doc, artist, snap0.channels[0].id, 'Box 1')
    setPatchField(doc, artist, snap0.channels[0].id, 'input', 'Kick, low')
    setPatchField(doc, artist, snap0.channels[1].id, 'micDi', 'SM57')

    const csv = sheetToCsv(snapshotSheet(doc))
    const { data, skippedColumns } = sheetFromCsv(parseCsv(csv))

    expect(skippedColumns).toEqual([])
    expect(data.artists.map((a) => a.name)).toEqual(['Headliner'])
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
    expect(data.artists).toHaveLength(1)
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
  it('creates a working doc from imported data', () => {
    const doc = new Y.Doc()
    buildImportedSheet(
      doc,
      {
        channels: [{ label: 'Kick' }, { label: '2' }],
        artists: [{ name: 'Band A' }],
        patches: [[{ input: 'Kick', micDi: 'Beta 91A' }, undefined]],
      },
      { title: 'Imported', now: '2026-07-24T10:00:00.000Z' }
    )
    const snap = snapshotSheet(doc)
    expect(snap.meta.title).toBe('Imported')
    expect(snap.channels.map((c) => c.label)).toEqual(['Kick', '2'])
    expect(snap.artists[0].name).toBe('Band A')
    const entry = snap.patches[patchKey(snap.artists[0].id, snap.channels[0].id)]
    expect(entry).toMatchObject({ input: 'Kick', micDi: 'Beta 91A' })
  })
})
