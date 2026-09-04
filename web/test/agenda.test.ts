import { describe, expect, it } from 'vitest'
import {
  agenda,
  DAY_ROLLS_AT,
  daysBetween,
  nowMinutes,
  showDate,
  relative,
  showMinutes,
  toAgendaAct,
  type AgendaAct,
} from '@crewbox/shared'

/**
 * Reading the timetable.
 *
 * Almost every test here is about time, because time is where a schedule
 * betrays a festival: the headliner is at 00:30, the day is numbered from
 * 19:00, and a naive sort puts the biggest act of the weekend first thing in
 * the morning.
 */

/** The show day these single-day tests are about. */
const FRI = '2026-06-19'
const SAT = '2026-06-20'

const act = (over: Partial<AgendaAct> & { id: string; start: number | null }): AgendaAct => ({
  name: over.id,
  stage: 'Main',
  date: FRI,
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
    const [main] = agenda(acts, at('20:30'), FRI)
    expect(main?.onNow?.act.id).toBe('middle')
    expect(main?.next?.act.id).toBe('headliner')
  })

  it('shows nothing on during a changeover, and names what is coming', () => {
    // The gap between sets is the busiest moment on a stage. "Nothing on,
    // headliner in 45" is the answer, not "middle, finished".
    const [main] = agenda(acts, at('21:15'), FRI)
    expect(main?.onNow).toBeNull()
    expect(main?.next?.act.id).toBe('headliner')
    expect(main?.next?.startsIn).toBe(45)
  })

  it('has nothing next once the stage is done', () => {
    const [main] = agenda(acts, at('23:45'), FRI)
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
    const [main] = agenda(open, at('19:30'), FRI)
    expect(main?.onNow?.act.id).toBe('first')
    expect(main?.onNow?.endsIn).toBe(30)
  })

  it('ignores acts with no time at all rather than guessing', () => {
    const withTbc = [...acts, act({ id: 'tbc', start: null })]
    const [main] = agenda(withTbc, at('19:10'), FRI)
    expect(main?.onNow?.act.id).toBe('opener')
  })
})

/**
 * A festival that runs more than one night.
 *
 * `toAgendaAct` dropped the date, so every act on a stage across the whole
 * weekend landed on one clock. On the Saturday at 21:30, with a Friday
 * headliner and a Saturday headliner both at 21:00, "on now" was Friday's
 * band — on every phone, on the board at front of house, and over the control
 * API to a production desk. The show log then copies that name into a
 * permanent record of who was on when something happened.
 *
 * Both test suites only ever seeded one day, which is why nothing caught it.
 */
describe('a festival that runs more than one night', () => {
  const weekend = [
    act({ id: 'fri-opener', date: FRI, start: at('19:00'), end: at('20:00') }),
    act({ id: 'fri-headliner', date: FRI, start: at('21:00'), end: at('22:30') }),
    act({ id: 'sat-opener', date: SAT, start: at('19:00'), end: at('20:00') }),
    act({ id: 'sat-headliner', date: SAT, start: at('21:00'), end: at('22:30') }),
  ]

  it('names the right headliner on the right night', () => {
    // The exact reported case.
    expect(agenda(weekend, at('21:30'), SAT)[0]?.onNow?.act.id).toBe('sat-headliner')
    expect(agenda(weekend, at('21:30'), FRI)[0]?.onNow?.act.id).toBe('fri-headliner')
  })

  it('never picks yesterday as what is next', () => {
    const [main] = agenda(weekend, at('18:00'), SAT)
    expect(main?.next?.act.id).toBe('sat-opener')
  })

  it('leaves the day that has been and gone out of it entirely', () => {
    // At 23:00 on the Saturday everything is over. "Nothing" is the answer;
    // Friday's opener at 19:00 is not.
    const [main] = agenda(weekend, at('23:00'), SAT)
    expect(main?.onNow).toBeNull()
    expect(main?.next).toBeNull()
  })

  it('offers tomorrow only once today has nothing left', () => {
    const [main] = agenda(weekend, at('23:00'), FRI)
    expect(main?.onNow).toBeNull()
    expect(main?.next?.act.id).toBe('sat-opener')
  })

  it('counts the whole gap to tomorrow, not just the clock', () => {
    // "in 20h", not "in 5 min". A countdown that ignored the day would have a
    // stage manager waiting by an empty stage.
    const [main] = agenda(weekend, at('23:00'), FRI)
    expect(main?.next?.startsIn).toBe(20 * 60)
  })

  it("does not end tonight's last set with tomorrow's first", () => {
    // An act with no end time runs until the next one starts — but only if
    // the next one is the same night. Otherwise the Friday headliner would
    // read as still on at lunchtime on the Saturday.
    const open = [
      act({ id: 'fri-last', date: FRI, start: at('22:00') }),
      act({ id: 'sat-first', date: SAT, start: at('12:00') }),
    ]
    const [main] = agenda(open, at('23:00'), FRI)
    expect(main?.onNow?.act.id).toBe('fri-last')
    expect(main?.onNow?.endsIn).toBeNull()
  })

  it('keeps the small hours on the night they belong to', () => {
    // 00:30 on the Saturday morning is Friday's show day, which is the same
    // rule showMinutes has always encoded. The act carries Friday's date.
    const late = [act({ id: 'closer', date: FRI, start: at('00:30'), end: at('02:00') })]
    expect(agenda(late, at('01:00'), FRI)[0]?.onNow?.act.id).toBe('closer')
    // And it is not somebody else's problem on the Saturday. The stage is
    // still listed — it exists — with nothing on it.
    expect(agenda(late, at('01:00'), SAT)[0]?.onNow).toBeNull()
  })

  it('still works for a sheet where nobody filled the date column', () => {
    // A single-day event, which is most of them. A blank date belongs to
    // whatever day is being asked about, so these behave exactly as before.
    const undated = [act({ id: 'a', date: '', start: at('19:00'), end: at('20:00') })]
    expect(agenda(undated, at('19:30'), SAT)[0]?.onNow?.act.id).toBe('a')
    expect(agenda(undated, at('19:30'), FRI)[0]?.onNow?.act.id).toBe('a')
  })

  it('refuses to guess at a date it cannot read', () => {
    // Rather than treating it as today and putting an unknown act on stage.
    const junk = [act({ id: 'junk', date: 'saturday', start: at('19:00') })]
    const [main] = agenda(junk, at('19:30'), SAT)
    expect(main?.onNow).toBeNull()
    expect(main?.next).toBeNull()
  })
})

describe('which show day it is', () => {
  it('is yesterday until six in the morning', () => {
    // Half past midnight on the Saturday is still Friday's show day: the set
    // on stage started at eleven on the Friday night. Without this the
    // timetable would change day underneath the crew mid-headline-slot.
    expect(showDate(new Date(2026, 5, 20, 0, 30))).toBe(FRI)
    expect(showDate(new Date(2026, 5, 20, 5, 59))).toBe(FRI)
  })

  it('rolls at six, where the load-ins start', () => {
    expect(showDate(new Date(2026, 5, 20, 6, 0))).toBe(SAT)
    expect(showDate(new Date(2026, 5, 20, 14, 0))).toBe(SAT)
  })

  it('handles the first of a month, and a year end', () => {
    expect(showDate(new Date(2026, 6, 1, 2, 0))).toBe('2026-06-30')
    expect(showDate(new Date(2027, 0, 1, 3, 0))).toBe('2026-12-31')
  })

  it('counts days without drifting across a clock change', () => {
    // Late March in Europe. Counted as UTC on both sides, so the answer is a
    // number of calendar days rather than a number of 24-hour spans.
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2)
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
    expect(daysBetween(FRI, FRI)).toBe(0)
    expect(daysBetween(SAT, FRI)).toBe(-1)
    expect(daysBetween(FRI, 'not a date')).toBeNull()
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
    const stages = agenda(acts, at('19:30'), FRI).map((s) => s.stage)
    expect(stages).toEqual(['Main', 'Barn', 'Acoustic'])
  })

  it('sinks a stage that has finished below one that has not', () => {
    const acts = [
      act({ id: 'done', stage: 'Barn', start: at('17:00'), end: at('18:00') }),
      act({ id: 'later', stage: 'Main', start: at('23:00') }),
    ]
    expect(agenda(acts, at('21:00'), FRI).map((s) => s.stage)).toEqual(['Main', 'Barn'])
  })

  it('falls back to a name rather than dropping a stageless sheet', () => {
    expect(
      agenda([act({ id: 'a', stage: '', start: at('19:00') })], at('19:30'), FRI)[0]?.stage
    ).toBe('Stage')
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
