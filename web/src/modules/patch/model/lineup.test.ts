import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { actsOnSheet, setSheetDate, setSheetStage, sheetActs } from './lineup'
import { emptyExtras, type SheetSnapshot } from './types'
import { addAct, snapshotTimetable, type Act } from '../../../shell/timetable/model.ts'

/**
 * How a patch sheet finds its own columns.
 *
 * This is the whole join between the event's running order and a sheet: the
 * sheet says which stage and which day it is, and the timetable answers with
 * the acts. Get it wrong in one direction and a sheet shows an empty grid; in
 * the other, it shows every other stage's acts as well as its own.
 */

const act = (over: Partial<Act> & { id: string }): Act => ({
  name: over.id,
  stage: 'Main',
  date: '2026-08-09',
  start: '',
  end: '',
  changeover: 0,
  ...over,
})

const snapshot = (over: Partial<SheetSnapshot> = {}): SheetSnapshot => ({
  meta: { title: 'Main Stage', stage: 'Main', date: '2026-08-09', created: '' },
  channels: [],
  subBoxes: [],
  extras: {},
  patches: {},
  ...over,
})

const withMeta = (stage: string, date: string) =>
  snapshot({ meta: { title: 't', stage, date, created: '' } })

describe('which acts a sheet covers', () => {
  const acts = [
    act({ id: 'main-fri', stage: 'Main', date: '2026-08-09' }),
    act({ id: 'barn-fri', stage: 'Barn', date: '2026-08-09' }),
    act({ id: 'main-sat', stage: 'Main', date: '2026-08-10' }),
  ]

  it('takes its own stage on its own day, and nothing else', () => {
    expect(actsOnSheet({ stage: 'Main', date: '2026-08-09' }, acts).map((a) => a.id)).toEqual([
      'main-fri',
    ])
  })

  it('matches a stage typed with stray spaces or a stray case', () => {
    expect(actsOnSheet({ stage: '  Main  ', date: '2026-08-09' }, acts)).toHaveLength(1)
  })

  it('takes the whole day when the sheet has no stage named yet', () => {
    // A blank grid is the worse answer for someone who has just made a sheet
    // and not got as far as saying which stage it is.
    expect(actsOnSheet({ stage: '', date: '2026-08-09' }, acts).map((a) => a.id)).toEqual([
      'main-fri',
      'barn-fri',
    ])
  })

  it('takes everything when it has neither', () => {
    expect(actsOnSheet({ stage: '', date: '' }, acts)).toHaveLength(3)
  })

  it('shows nothing rather than someone else’s stage when the name is wrong', () => {
    // The failure this arrangement can produce: "Main Stage" typed where the
    // running order says "Main". Empty is the honest answer, and the sheet's
    // own empty state says so and offers the names in use.
    expect(actsOnSheet({ stage: 'Main Stage', date: '2026-08-09' }, acts)).toHaveLength(0)
  })
})

describe('the order the columns come out in', () => {
  it('sorts by the clock, not by when they were typed in', () => {
    const acts = [
      act({ id: 'late', start: '22:00' }),
      act({ id: 'early', start: '19:00' }),
      act({ id: 'middle', start: '20:30' }),
    ]
    expect(sheetActs(snapshot(), acts).map((a) => a.id)).toEqual(['early', 'middle', 'late'])
  })

  it('puts a set that starts after midnight at the end of the night', () => {
    // The one a plain string sort gets wrong, and gets wrong in the most
    // visible place on the sheet: the headliner would be the first column.
    const acts = [act({ id: 'headliner', start: '00:30' }), act({ id: 'opener', start: '19:00' })]
    expect(sheetActs(snapshot(), acts).map((a) => a.id)).toEqual(['opener', 'headliner'])
  })

  it('puts acts with no time yet last, in the order they were added', () => {
    const acts = [act({ id: 'tbc-1' }), act({ id: 'timed', start: '21:00' }), act({ id: 'tbc-2' })]
    expect(sheetActs(snapshot(), acts).map((a) => a.id)).toEqual(['timed', 'tbc-1', 'tbc-2'])
  })
})

describe('merging the sheet’s own half back in', () => {
  it('carries the spec, notes and files for the acts it has them for', () => {
    const acts = [act({ id: 'a1', start: '19:00' }), act({ id: 'a2', start: '20:00' })]
    const snap = snapshot({
      extras: {
        a1: {
          ...emptyExtras('a1'),
          spec: '5 piece',
          files: [{ id: 'f1', name: 'rider.pdf', type: 'application/pdf', size: 1 }],
        },
      },
    })

    const [first, second] = sheetActs(snap, acts)
    expect(first).toMatchObject({ name: 'a1', start: '19:00', spec: '5 piece' })
    expect(first!.files.map((f) => f.name)).toEqual(['rider.pdf'])
    // An act nothing has been said about reads as empty, never undefined —
    // the lineup binds textareas straight to these.
    expect(second).toMatchObject({ spec: '', notes: '', files: [] })
  })

  it('drops an act the running order no longer has, keeping what it held', () => {
    // Deleting an act elsewhere must not put `undefined` through the grid.
    const snap = snapshot({ extras: { gone: { ...emptyExtras('gone'), spec: 'orphan' } } })
    expect(sheetActs(snap, [])).toEqual([])
    expect(snap.extras.gone!.spec).toBe('orphan')
  })

  it('follows a sheet that is pointed at a different stage', () => {
    const acts = [act({ id: 'main' }), act({ id: 'barn', stage: 'Barn' })]
    expect(sheetActs(withMeta('Barn', '2026-08-09'), acts).map((a) => a.id)).toEqual(['barn'])
  })
})

describe('renaming the stage a sheet is for', () => {
  /**
   * The trap this exists to close: the stage decides the columns, so a
   * rename on its own leaves every act filed under the old spelling and the
   * grid blank, with nothing saying why.
   */
  const seed = (stage: string) => {
    const events = new Y.Doc()
    const mine = addAct(events, { name: 'Mine', stage, date: '2026-08-09' })
    const theirs = addAct(events, { name: 'Theirs', stage: 'Barn', date: '2026-08-09' })
    return { events, mine, theirs }
  }
  const showing = (events: Y.Doc, meta: { stage: string; date: string }) =>
    sheetActs(withMeta(meta.stage, meta.date), snapshotTimetable(events).acts)

  it('takes the sheet’s acts with it', () => {
    const { events, mine } = seed('festival-master-patch')
    const meta = { stage: 'festival-master-patch', date: '2026-08-09' }

    setSheetStage(events, meta, showing(events, meta), 'Main')

    const after = snapshotTimetable(events).acts
    expect(after.find((a) => a.id === mine)?.stage).toBe('Main')
    expect(showing(events, { stage: 'Main', date: '2026-08-09' }).map((a) => a.name)).toEqual([
      'Mine',
    ])
  })

  it('leaves another stage’s acts where they are', () => {
    const { events, theirs } = seed('Main')
    const meta = { stage: 'Main', date: '2026-08-09' }
    setSheetStage(events, meta, showing(events, meta), 'Main Stage')
    expect(snapshotTimetable(events).acts.find((a) => a.id === theirs)?.stage).toBe('Barn')
  })

  it('moves nothing when the sheet had no stage named yet', () => {
    // A stageless sheet is showing the whole day. Dragging every act on it
    // onto one name would be a rename of the entire event, not of a sheet.
    const { events } = seed('Main')
    const meta = { stage: '', date: '2026-08-09' }
    setSheetStage(events, meta, showing(events, meta), 'Main')
    expect(
      snapshotTimetable(events)
        .acts.map((a) => a.stage)
        .sort()
    ).toEqual(['Barn', 'Main'])
  })
})

describe('moving a sheet to another day', () => {
  /**
   * The same trap as the stage rename, on the other half of the join — and
   * it was open. Between them the stage and the date decide the columns, so
   * changing the date on its own left every act filed under the old one and
   * the grid blank, with nothing saying why. It is the ordinary correction
   * for a sheet an import stamped with the load-in day.
   */
  const seed = () => {
    const events = new Y.Doc()
    const mine = addAct(events, { name: 'Mine', stage: 'Main', date: '2026-08-09' })
    const other = addAct(events, { name: 'Other Day', stage: 'Main', date: '2026-08-10' })
    return { events, mine, other }
  }
  const showing = (events: Y.Doc, meta: { stage: string; date: string }) =>
    sheetActs(withMeta(meta.stage, meta.date), snapshotTimetable(events).acts)

  it('takes the sheet’s acts with it', () => {
    const { events, mine } = seed()
    const meta = { stage: 'Main', date: '2026-08-09' }

    setSheetDate(events, meta, showing(events, meta), '2026-08-11')

    expect(snapshotTimetable(events).acts.find((a) => a.id === mine)?.date).toBe('2026-08-11')
    expect(showing(events, { stage: 'Main', date: '2026-08-11' }).map((a) => a.name)).toEqual([
      'Mine',
    ])
  })

  it('leaves another day’s acts where they are', () => {
    const { events, other } = seed()
    const meta = { stage: 'Main', date: '2026-08-09' }
    setSheetDate(events, meta, showing(events, meta), '2026-08-11')
    expect(snapshotTimetable(events).acts.find((a) => a.id === other)?.date).toBe('2026-08-10')
  })

  it('moves nothing when the sheet had no date yet', () => {
    // A dateless sheet is showing every day. Dragging the whole festival
    // onto one date would be a change to the event, not to a sheet.
    const { events } = seed()
    const meta = { stage: 'Main', date: '' }
    setSheetDate(events, meta, showing(events, meta), '2026-08-11')
    expect(
      snapshotTimetable(events)
        .acts.map((a) => a.date)
        .sort()
    ).toEqual(['2026-08-09', '2026-08-10'])
  })

  it('does nothing at all when the date has not changed', () => {
    const { events, mine } = seed()
    const meta = { stage: 'Main', date: '2026-08-09' }
    setSheetDate(events, meta, showing(events, meta), '2026-08-09')
    expect(snapshotTimetable(events).acts.find((a) => a.id === mine)?.date).toBe('2026-08-09')
  })
})
