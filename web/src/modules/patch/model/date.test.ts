import { describe, expect, it } from 'vitest'
import { displayToIso, isoToDisplay, todayIso } from './date'

describe('todayIso', () => {
  it('uses the local calendar date, not UTC', () => {
    // Construct a local-time date; the result must reflect local fields.
    const local = new Date(2026, 0, 5, 23, 30) // 5 Jan 2026, 23:30 local
    expect(todayIso(local)).toBe('2026-01-05')
  })
})

describe('isoToDisplay', () => {
  it('formats YYYY-MM-DD as DD/MM/YYYY with pure string ops', () => {
    expect(isoToDisplay('2026-07-23')).toBe('23/07/2026')
    expect(isoToDisplay('2024-01-02')).toBe('02/01/2024')
  })

  it('returns non-ISO input unchanged', () => {
    expect(isoToDisplay('soon')).toBe('soon')
    expect(isoToDisplay('')).toBe('')
  })
})

describe('displayToIso', () => {
  it('parses valid DD/MM/YYYY', () => {
    expect(displayToIso('23/07/2026')).toBe('2026-07-23')
    expect(displayToIso('1/2/2026')).toBe('2026-02-01')
    expect(displayToIso(' 05/11/2030 ')).toBe('2030-11-05')
  })

  it('rejects invalid dates', () => {
    expect(displayToIso('32/01/2026')).toBeNull()
    expect(displayToIso('10/13/2026')).toBeNull()
    expect(displayToIso('01/01/1899')).toBeNull()
    expect(displayToIso('2026-07-23')).toBeNull()
    expect(displayToIso('hello')).toBeNull()
  })

  it('rejects days that are in range but not in the month', () => {
    // 31 and 12 both pass a range check. The date is a join key against the
    // timetable, so a sheet dated 2026-02-31 matches no act and never will —
    // the grid simply comes up empty with nothing saying why.
    expect(displayToIso('31/02/2026')).toBeNull()
    expect(displayToIso('31/04/2026')).toBeNull()
    expect(displayToIso('30/02/2026')).toBeNull()
  })

  it('knows which Februaries have a 29th', () => {
    expect(displayToIso('29/02/2024')).toBe('2024-02-29')
    expect(displayToIso('29/02/2026')).toBeNull()
    // 2100 is not a leap year; a range check and a naive %4 both say it is.
    expect(displayToIso('29/02/2100')).toBeNull()
  })
})
