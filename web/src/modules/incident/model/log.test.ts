import { describe, expect, it } from 'vitest'
import type { Incident } from '@crewbox/shared'
import {
  byShowDay,
  filterLog,
  inLogOrder,
  loggedLate,
  seriousCount,
  showDayOf,
  withCorrections,
} from './log.ts'

/**
 * Reading a night back.
 *
 * The tests that matter are about time, like everything else in this app that
 * touches a festival: an entry belongs where the thing happened, the night
 * does not end at midnight, and a correction never hides what it corrects.
 */

let seq = 0
const at = (h: number, m: number, day = 11) => new Date(2026, 7, day, h, m).getTime()

const entry = (over: Partial<Incident> = {}): Incident => ({
  id: `i-${++seq}`,
  seq,
  authorId: 'u1',
  authorName: 'Maya Quinn',
  kind: 'note',
  severity: 'note',
  body: '',
  at: at(21, 0),
  loggedAt: at(21, 0),
  stage: '',
  actId: '',
  actName: '',
  ...over,
})

describe('the order a log is read in', () => {
  it('puts the most recent thing that happened at the top', () => {
    const early = entry({ at: at(19, 30) })
    const late = entry({ at: at(22, 30) })
    expect(inLogOrder([early, late]).map((e) => e.id)).toEqual([late.id, early.id])
  })

  it('sorts by when it happened, not by when it was typed', () => {
    // The whole point of two timestamps. Somebody writing up the 19:30
    // barrier at 22:00 must not have it land above the 21:00 show stop.
    const backdated = entry({ at: at(19, 30), loggedAt: at(22, 0) })
    const showStop = entry({ at: at(21, 0), loggedAt: at(21, 1) })
    expect(inLogOrder([backdated, showStop]).map((e) => e.id)).toEqual([showStop.id, backdated.id])
  })

  it('falls back to the sequence when two entries claim the same minute', () => {
    const first = entry({ at: at(21, 0) })
    const second = entry({ at: at(21, 0) })
    expect(inLogOrder([first, second]).map((e) => e.id)).toEqual([second.id, first.id])
  })
})

describe('corrections', () => {
  it('hang under what they correct rather than replacing it', () => {
    const original = entry({ body: 'Show stopped 21:04' })
    const fix = entry({ body: 'Correction: 21:14', amends: original.id })

    const lines = withCorrections([original, fix])
    expect(lines).toHaveLength(1)
    expect(lines[0]?.entry.body).toBe('Show stopped 21:04')
    expect(lines[0]?.corrections.map((c) => c.body)).toEqual(['Correction: 21:14'])
  })

  it('stand alone when the entry they correct is off the page', () => {
    // Scrollback loads newest first, so a correction can arrive long before
    // the entry it names. Hiding it until the original loads would lose it.
    const orphan = entry({ body: 'Correction to something older', amends: 'not-loaded-yet' })
    expect(withCorrections([orphan]).map((l) => l.entry.id)).toEqual([orphan.id])
  })

  it('keeps several corrections in the order they were written', () => {
    const original = entry({ body: 'Show stopped' })
    const first = entry({ body: 'first correction', amends: original.id })
    const second = entry({ body: 'second correction', amends: original.id })
    const [line] = withCorrections([second, original, first])
    expect(line?.corrections.map((c) => c.body)).toEqual(['first correction', 'second correction'])
  })
})

describe('how late it was written down', () => {
  it('counts the minutes between the thing and the typing', () => {
    expect(loggedLate(entry({ at: at(21, 0), loggedAt: at(21, 12) }))).toBe(12)
  })

  it('never reports a negative, whatever a phone clock says', () => {
    expect(loggedLate(entry({ at: at(21, 30), loggedAt: at(21, 0) }))).toBe(0)
  })
})

describe('which night an entry belongs to', () => {
  it('files the small hours under the night that started them', () => {
    // 00:30 belongs to the night of the 11th. A log that splits the barrier
    // incident from the show stop it followed makes a stage manager read one
    // night as two.
    expect(showDayOf(at(0, 30, 12))).toBe('2026-08-11')
    expect(showDayOf(at(23, 30, 11))).toBe('2026-08-11')
  })

  it('files a load-in the morning after under the new day', () => {
    expect(showDayOf(at(7, 0, 12))).toBe('2026-08-12')
  })

  it('groups the log into nights, newest first', () => {
    const tonight = entry({ at: at(21, 0, 11) })
    const smallHours = entry({ at: at(0, 30, 12) })
    const tomorrow = entry({ at: at(20, 0, 12) })
    const days = byShowDay([tonight, smallHours, tomorrow])
    expect(days.map((d) => d.day)).toEqual(['2026-08-12', '2026-08-11'])
    expect(days[1]?.lines.map((l) => l.entry.id)).toEqual([smallHours.id, tonight.id])
  })
})

describe('narrowing a long night', () => {
  const log = [
    entry({ kind: 'medical', severity: 'serious', body: 'First aid to a punter', stage: 'Main' }),
    entry({ kind: 'technical', severity: 'issue', body: 'Desk rebooted', stage: 'Second' }),
    entry({ kind: 'note', body: 'Barrier moved', stage: 'Main', actName: 'Night Bus' }),
  ]

  it('filters by kind, severity and stage', () => {
    expect(filterLog(log, { kind: 'medical' })).toHaveLength(1)
    expect(filterLog(log, { severity: 'serious' })).toHaveLength(1)
    expect(filterLog(log, { stage: 'main' })).toHaveLength(2)
  })

  it('searches the words, the act and who wrote it', () => {
    expect(filterLog(log, { q: 'rebooted' })).toHaveLength(1)
    expect(filterLog(log, { q: 'night bus' })).toHaveLength(1)
    expect(filterLog(log, { q: 'maya' })).toHaveLength(3)
  })

  it('changes nothing when nothing is asked', () => {
    expect(filterLog(log, {})).toHaveLength(3)
    expect(filterLog(log, { kind: 'all', severity: 'all', stage: '', q: '  ' })).toHaveLength(3)
  })

  it('counts what a sidebar badge should say', () => {
    expect(seriousCount(log)).toBe(1)
  })
})
