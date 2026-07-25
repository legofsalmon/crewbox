import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { csvFilename, escapeCsvField, sheetToCsv } from './csv'
import {
  addSubBox,
  initSheet,
  renameChannel,
  setMetaField,
  setPatchField,
  setPatchSubBox,
  snapshotSheet,
  updateArtist,
} from './sheetDoc'

const buildSheet = () => {
  const doc = new Y.Doc()
  initSheet(doc, {
    title: 'Summer Fest',
    date: '2026-07-23',
    now: '2026-07-23T10:00:00.000Z',
    channelCount: 2,
  })
  return doc
}

describe('escapeCsvField', () => {
  it('passes plain values through, including times like 19:00', () => {
    expect(escapeCsvField('19:00')).toBe('19:00')
    expect(escapeCsvField('SM58')).toBe('SM58')
  })

  it('quotes and doubles values containing commas, quotes, and newlines', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"')
  })
})

describe('sheetToCsv', () => {
  it('renders BOM, CRLF rows, artist and field headers, and channel rows', () => {
    const doc = buildSheet()
    const snap = snapshotSheet(doc)
    const artist = snap.artists[0].id
    updateArtist(doc, artist, { name: 'The Band, Live' })
    renameChannel(doc, snap.channels[0].id, 'Kick')
    setPatchField(doc, artist, snap.channels[0].id, 'input', 'Drums')
    setPatchField(doc, artist, snap.channels[0].id, 'micDi', 'Beta 91A')

    const csv = sheetToCsv(snapshotSheet(doc))
    expect(csv.startsWith('\uFEFF')).toBe(true)

    const lines = csv.slice(1).split('\r\n')
    expect(lines[0]).toBe(',"The Band, Live",,,,')
    expect(lines[1]).toBe('Channel,Sub-box,Input,Description,Mic/DI,Stand')
    expect(lines[2]).toBe('Kick,,Drums,,Beta 91A,')
    expect(lines[3]).toBe('2,,,,,')
    expect(lines[4]).toBe('')
  })

  it('exports sub-box references as their display name', () => {
    const doc = buildSheet()
    const snap = snapshotSheet(doc)
    const artist = snap.artists[0].id
    addSubBox(doc, { name: 'Box 1', stagePosition: 'MSC' })
    setPatchSubBox(doc, artist, snap.channels[0].id, 'Box 1')

    const csv = sheetToCsv(snapshotSheet(doc))
    expect(csv).toContain('1,Box 1 (MSC),,,,')
  })
})

describe('csvFilename', () => {
  it('sanitises title and stage and keeps the ISO date', () => {
    const doc = buildSheet()
    setMetaField(doc, 'stage', 'Main Stage!')
    expect(csvFilename(snapshotSheet(doc))).toBe('Summer_Fest_Main_Stage__2026-07-23.csv')
  })

  it('falls back for empty fields', () => {
    const doc = new Y.Doc()
    initSheet(doc, { title: ' ', date: '2026-01-01', channelCount: 1 })
    const snap = snapshotSheet(doc)
    expect(csvFilename(snap)).toBe('Untitled_Sheet_stage_2026-01-01.csv')
  })
})
