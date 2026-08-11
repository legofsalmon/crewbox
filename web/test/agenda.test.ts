import { describe, expect, it } from 'vitest'
import {
  agenda,
  DAY_ROLLS_AT,
  nowMinutes,
  relative,
  showMinutes,
  toAgendaAct,
  type AgendaAct,
} from '../src/shell/timetable/agenda.ts'

/**
 * Reading the timetable.
 *
 * Almost every test here is about time, because time is where a schedule
 * betrays a festival: the headliner is at 00:30, the day is numbered from
 * 19:00, and a naive sort puts the biggest act of the weekend first thing in
 * the morning.
 */

const act = (over: Partial<AgendaAct> & { id: string; start: number | null }): AgendaAct => ({
  name: over.id,
  stage: 'Main',
  end: null,
  changeover: 0,
  ...over,
})

const at = (clock: string) => showMinutes(Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)))

describe('a show day that runs past midnight', () => {
  it('puts 00:30 after 23:00, not first thing in the morning', () => {
    expect(showMinutes(30)).toBeGreaterThan(showMinutes(23 * 60))
  })

  it('treats the small hours as the same night', () => {
    // Nothing is programmed between four and six; a load-in at 07:00 is a
    // new day. That is what the boundary encodes.
    expect(DAY_ROLLS_AT).toBe(360)
    expect(showMinutes(DAY_ROLLS_AT - 1)).toBeGreaterThan(24 * 60)
    expect(showMinutes(DAY_ROLLS_AT)).toBeLessThan(24 * 60)
  })

  it('measures a set that crosses midnight by its length', () => {
    // 23:40-00:20 is forty minutes. Mapping the two clock times separately
    // makes it twenty hours long in one direction or minus twenty in the
    // other, both of which put the act in the wrong place all night.
    const crossing = toAgendaAct({
      id: 'a',
      name: 'Headliner',
      stage: 'Main',
      date: '',
      start: '23:40',
      end: '00:20',
      changeover: 0,
    })
    expect(crossing.end! - crossing.start!).toBe(40)
  })

  it('keeps an ordinary set ordinary', () => {
    const normal = toAgendaAct({
      id: 'a',
      name: 'Opener',
      stage: 'Main',
      date: '',
      start: '19:00',
      end: '19:45',
      changeover: 0,
    })
    expect(normal.end! - normal.start!).toBe(45)
  })

  it('never turns a missing time into midnight', () => {
    // A blank cell that read as 00:00 would put a TBC act at the top of the
    // running order, which is worse than showing nothing.
    const blank = toAgendaAct({
      id: 'a',
      name: 'TBC',
      stage: 'Main',
      date: '',
      start: '',
      end: '',
      changeover: 0,
    })
    expect(blank.start).toBeNull()
    expect(blank.end).toBeNull()
  })
})

describe('what is on, and what is next', () => {
  const acts = [
    act({ id: 'opener', start: at('19:00'), end: at('19:45') }),
    act({ id: 'middle', start: at('20:15'), end: at('21:15') }),
    act({ id: 'headliner', start: at('22:00'), end: at('23:30') }),
  ]

  it('finds the act playing right now', () => {
    const [main] = agenda(acts, at('20:30'))
    expect(main?.onNow?.act.id).toBe('middle')
    expect(main?.next?.act.id).toBe('headliner')
  })

  it('shows nothing on during a changeover, and names what is coming', () => {
    // The gap between sets is the busiest moment on a stage. "Nothing on,
    // headliner in 45" is the answer, not "middle, finished".
    const [main] = agenda(acts, at('21:15'))
    expect(main?.onNow).toBeNull()
    expect(main?.next?.act.id).toBe('headliner')
    expect(main?.next?.startsIn).toBe(45)
  })

  it('has nothing next once the stage is done', () => {
    const [main] = agenda(acts, at('23:45'))
    expect(main?.onNow).toBeNull()
    expect(main?.next).toBeNull()
  })

  it('runs an act with no end time up to the next one', () => {
    // Plenty of sheets have start times and blank end columns. Without this
    // every set would read as over the instant it began.
    const open = [
      act({ id: 'first', start: at('19:00') }),
      act({ id: 'second', start: at('20:00') }),
    ]
    const [main] = agenda(open, at('19:30'))
    expect(main?.onNow?.act.id).toBe('first')
    expect(main?.onNow?.endsIn).toBe(30)
  })

  it('ignores acts with no time at all rather than guessing', () => {
    const withTbc = [...acts, act({ id: 'tbc', start: null })]
    const [main] = agenda(withTbc, at('19:10'))
    expect(main?.onNow?.act.id).toBe('opener')
  })
})

describe('several stages', () => {
  it('puts whatever is happening soonest at the top', () => {
    // Read on a phone, standing up. The stage with something on it belongs
    // first, not the alphabetically luckiest one.
    const acts = [
      act({ id: 'a', stage: 'Acoustic', start: at('23:00') }),
      act({ id: 'b', stage: 'Main', start: at('19:00'), end: at('20:00') }),
      act({ id: 'c', stage: 'Barn', start: at('20:30') }),
    ]
    const stages = agenda(acts, at('19:30')).map((s) => s.stage)
    expect(stages).toEqual(['Main', 'Barn', 'Acoustic'])
  })

  it('sinks a stage that has finished below one that has not', () => {
    const acts = [
      act({ id: 'done', stage: 'Barn', start: at('17:00'), end: at('18:00') }),
      act({ id: 'later', stage: 'Main', start: at('23:00') }),
    ]
    expect(agenda(acts, at('21:00')).map((s) => s.stage)).toEqual(['Main', 'Barn'])
  })

  it('falls back to a name rather than dropping a stageless sheet', () => {
    expect(agenda([act({ id: 'a', stage: '', start: at('19:00') })], at('19:30'))[0]?.stage).toBe(
      'Stage'
    )
  })
})

describe('reading it at a glance', () => {
  it('says the things a countdown needs to say', () => {
    expect(relative(0)).toBe('now')
    expect(relative(25)).toBe('in 25 min')
    expect(relative(130)).toBe('in 2h 10m')
    expect(relative(120)).toBe('in 2h')
    expect(relative(-5)).toBe('5 min ago')
  })

  it('reads the wall clock in local time, not UTC', () => {
    // The patch module learned this the hard way with dates: anything routed
    // through UTC is silently a day or an hour out for half the planet.
    const evening = new Date(2026, 7, 9, 20, 30)
    expect(nowMinutes(evening)).toBe(showMinutes(20 * 60 + 30))
  })
})
