import { describe, expect, it } from 'vitest'
import { parseClock } from '@crewbox/shared'
import { formatChangeover, gapBetween, parseChangeover } from './changeover'

/**
 * The changeover cell is free text somebody types between two bands while
 * standing up, so the parser has to take what crews actually write. "HR" for
 * an hour is the one that matters most — it is what the real sheet uses and
 * it is not a number at all.
 */

describe('reading a changeover cell', () => {
  it('takes a bare number as minutes', () => {
    expect(parseChangeover('45')).toBe(45)
    expect(parseChangeover(' 90 ')).toBe(90)
    expect(parseChangeover('0')).toBe(0)
  })

  it('takes "HR" as an hour, with or without the 1 in front', () => {
    // The real sheet writes plain "HR". Reading it as null would silently
    // lose two of the three changeovers on a four-act day.
    expect(parseChangeover('HR')).toBe(60)
    expect(parseChangeover('hr')).toBe(60)
    expect(parseChangeover('1HR')).toBe(60)
    expect(parseChangeover('1 hr')).toBe(60)
    expect(parseChangeover('1 hour')).toBe(60)
    expect(parseChangeover('2 hrs')).toBe(120)
  })

  it('takes an hour with minutes after it', () => {
    expect(parseChangeover('1hr30')).toBe(90)
    expect(parseChangeover('1h30')).toBe(90)
    expect(parseChangeover('1:30')).toBe(90)
    expect(parseChangeover('1.30')).toBe(90)
  })

  it('takes minutes spelled out', () => {
    expect(parseChangeover('45m')).toBe(45)
    expect(parseChangeover('45 min')).toBe(45)
    expect(parseChangeover('45 mins')).toBe(45)
  })

  it('returns null rather than a number that would join in the arithmetic', () => {
    expect(parseChangeover('')).toBeNull()
    expect(parseChangeover('   ')).toBeNull()
    expect(parseChangeover('TBC')).toBeNull()
    expect(parseChangeover('ask Dave')).toBeNull()
    expect(parseChangeover('HR?')).toBeNull()
  })
})

describe('saying it back', () => {
  it('reads the way it is said out loud', () => {
    expect(formatChangeover(45)).toBe('45 min')
    expect(formatChangeover(60)).toBe('1 hr')
    expect(formatChangeover(90)).toBe('1 hr 30')
    expect(formatChangeover(120)).toBe('2 hr')
  })

  it('says nothing for nothing', () => {
    expect(formatChangeover(0)).toBe('')
    expect(formatChangeover(-5)).toBe('')
    expect(formatChangeover(Number.NaN)).toBe('')
  })
})

describe('what the running order implies', () => {
  it('is the gap from one act coming down to the next going on', () => {
    expect(gapBetween('18:00', '18:45')).toBe(45)
    expect(gapBetween('19:45', '20:45')).toBe(60)
  })

  it('handles a stage running past midnight', () => {
    // A headline set ending at 00:15 is a normal festival day, not a
    // negative changeover.
    expect(gapBetween('23:30', '00:15')).toBe(45)
    expect(gapBetween('00:15', '01:00')).toBe(45)
  })

  it('declines a gap so big it is probably a different day', () => {
    // Reading a 14-hour hole as a changeover would put nonsense on the
    // lineup with no way to tell it from a real number.
    expect(gapBetween('18:00', '10:00')).toBeNull()
  })

  it('says nothing when the times do not', () => {
    expect(gapBetween('', '18:45')).toBeNull()
    expect(gapBetween('18:00', '')).toBeNull()
    expect(gapBetween('teatime', '18:45')).toBeNull()
  })

  it('reads a clock the several ways a sheet writes one', () => {
    expect(parseClock('19:00')).toBe(19 * 60)
    expect(parseClock('9:05')).toBe(9 * 60 + 5)
    expect(parseClock('19.00')).toBe(19 * 60)
    expect(parseClock('25:00')).toBeNull()
    expect(parseClock('19:70')).toBeNull()
  })
})
