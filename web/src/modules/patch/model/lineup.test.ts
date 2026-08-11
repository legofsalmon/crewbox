import { describe, expect, it } from 'vitest'
import { actsOnSheet, sheetActs } from './lineup'
import { emptyExtras, type SheetSnapshot } from './types'
import type { Act } from '../../../shell/timetable/model.ts'

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
