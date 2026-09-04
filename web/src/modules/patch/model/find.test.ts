import { describe, expect, it } from 'vitest'
import { channelCellId, findMatches } from './find'
import type { SheetAct, SheetSnapshot } from './types'
import { emptyPatchEntry } from './types'

/**
 * The column find-in-sheet never looked at.
 *
 * The house input is the sheet's spine — what is on channel 12 all day,
 * whoever is playing. Searching for "KICK IN" found every act's mic and DI
 * cells and not the one row that says what channel 1 actually is, which is
 * the row somebody typing that query is usually after. It is also the only
 * column with the same value for every act, so the miss is the least visible
 * and the most annoying: the search looks like it worked.
 */

const acts: SheetAct[] = [
  {
    id: 'act-1',
    name: 'The Harbour Lights',
    stage: 'Main',
    date: '',
    start: '',
    end: '',
    changeover: 0,
    spec: '',
    notes: '',
    files: [],
  },
]

const snapshot = (): SheetSnapshot => ({
  meta: { title: 'Main', stage: 'Main', date: '2026-07-24', created: '' },
  channels: [
    { id: 'ch-1', label: '1', input: 'KICK IN' },
    { id: 'ch-2', label: 'TB', input: 'TALKBACK' },
  ],
  subBoxes: [],
  extras: {},
  patches: {
    'act-1:ch-1': { ...emptyPatchEntry(), micDi: 'BEYER', input: 'Kick' },
  },
})

describe('finding things on a sheet', () => {
  it('searches the house input column', () => {
    const found = findMatches(snapshot(), acts, 'kick in')
    expect([...found.inputs]).toEqual(['ch-1'])
    // And it is navigable, like every other match.
    expect(found.order).toContain(channelCellId('ch-1', 'input'))
  })

  it('still searches channel numbers and names', () => {
    const found = findMatches(snapshot(), acts, 'tb')
    expect([...found.channels]).toEqual(['ch-2'])
    expect(found.order).toContain(channelCellId('ch-2', 'label'))
  })

  it('still searches the patch cells', () => {
    const found = findMatches(snapshot(), acts, 'beyer')
    expect([...found.cells]).toEqual(['act-1:ch-1:micDi'])
  })

  it('reads a row before the acts across it', () => {
    // The order somebody reads the row in, so the "next match" walk goes the
    // way their eye does.
    const found = findMatches(snapshot(), acts, 'kick')
    expect(found.order).toEqual([channelCellId('ch-1', 'input'), 'act-1:ch-1:input'])
  })

  it('finds nothing for an empty query, rather than everything', () => {
    const found = findMatches(snapshot(), acts, '   ')
    expect(found.order).toEqual([])
    expect(found.inputs.size).toBe(0)
  })
})
