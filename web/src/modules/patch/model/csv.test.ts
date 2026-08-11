import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { csvFilename, escapeCsvField, sheetToCsv } from './csv'
import {
  addSubBox,
  initSheet,
  renameChannel,
  setChannelInput,
  setMetaField,
  setPatchField,
  setPatchSubBox,
  snapshotSheet,
} from './sheetDoc'
import { sheetActs } from './lineup'
import { addAct, snapshotTimetable, updateAct } from '../../../shell/timetable/model.ts'

const buildSheet = () => {
  const doc = new Y.Doc()
  const events = new Y.Doc()
  initSheet(doc, events, {
    title: 'Summer Fest',
    date: '2026-07-23',
    now: '2026-07-23T10:00:00.000Z',
    channelCount: 2,
  })
  return { doc, events, act: snapshotTimetable(events).acts[0]!.id }
}

/** The columns as the grid has them: this sheet's slice of the running order. */
const columns = (doc: Y.Doc, events: Y.Doc) =>
  sheetActs(snapshotSheet(doc), snapshotTimetable(events).acts)

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
  it('renders BOM, CRLF rows, act and field headers, and channel rows', () => {
    const { doc, events, act } = buildSheet()
    const snap = snapshotSheet(doc)
    updateAct(events, act, { name: 'The Band, Live' })
    renameChannel(doc, snap.channels[0].id, 'Kick')
    setChannelInput(doc, snap.channels[0].id, 'Kick In')
    setPatchField(doc, act, snap.channels[0].id, 'input', 'Drums')
    setPatchField(doc, act, snap.channels[0].id, 'micDi', 'Beta 91A')

    const csv = sheetToCsv(snapshotSheet(doc), columns(doc, events))
    expect(csv.startsWith('\uFEFF')).toBe(true)

    const lines = csv.slice(1).split('\r\n')
    // Channel and its house input lead; each act's spec rides in the spare
    // cell beside their name, where the field parser never looks.
    expect(lines[0]).toBe(',,"The Band, Live",,,,')
    expect(lines[1]).toBe('Channel,Input,Sub-box,Input,Description,Mic/DI,Stand')
    expect(lines[2]).toBe('Kick,Kick In,,Drums,,Beta 91A,')
    expect(lines[3]).toBe('2,,,,,,')
    expect(lines[4]).toBe('')
  })

  it('exports sub-box references as their display name', () => {
    const { doc, events, act } = buildSheet()
    const snap = snapshotSheet(doc)
    addSubBox(doc, { name: 'Box 1', stagePosition: 'MSC' })
    setPatchSubBox(doc, act, snap.channels[0].id, 'Box 1')

    const csv = sheetToCsv(snapshotSheet(doc), columns(doc, events))
    expect(csv).toContain('1,,Box 1 (MSC),,,,')
  })

  it('exports the acts in running order, not in the order they were added', () => {
    // A festival CSV is read left to right against a day that runs left to
    // right, so a late addition at 19:00 belongs first however it got there.
    const { doc, events, act } = buildSheet()
    updateAct(events, act, { name: 'Headliner', start: '22:00' })
    addAct(events, { name: 'Opener', stage: 'Summer Fest', date: '2026-07-23', start: '19:00' })

    const csv = sheetToCsv(snapshotSheet(doc), columns(doc, events))
    const names = csv.slice(1).split('\r\n')[0]
    expect(names.indexOf('Opener')).toBeLessThan(names.indexOf('Headliner'))
  })
})

describe('csvFilename', () => {
  it('sanitises title and stage and keeps the ISO date', () => {
    const { doc } = buildSheet()
    setMetaField(doc, 'stage', 'Main Stage!')
    expect(csvFilename(snapshotSheet(doc))).toBe('Summer_Fest_Main_Stage__2026-07-23.csv')
  })

  it('falls back for empty fields', () => {
    const doc = new Y.Doc()
    initSheet(doc, new Y.Doc(), { title: ' ', date: '2026-01-01', channelCount: 1 })
    const snap = snapshotSheet(doc)
    expect(csvFilename(snap)).toBe('Untitled_Sheet_stage_2026-01-01.csv')
  })
})
