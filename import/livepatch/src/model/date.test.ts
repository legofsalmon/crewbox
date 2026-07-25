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
})
