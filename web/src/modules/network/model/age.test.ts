import { describe, expect, it } from 'vitest'
import { reportAge } from './age.ts'

/**
 * The pane kept a report on screen when its refreshes started failing, with
 * nothing saying so — offline is the default here and blanking the pane
 * would be worse, but a crew chief could be reading a green verdict from
 * before somebody unplugged the switch. So the age is always on screen.
 */

const at = (minutes: number) => reportAge(0, minutes * 60_000)

describe('how old the verdict is', () => {
  it('says just now for the first minute', () => {
    expect(at(0)).toBe('just now')
    expect(at(0.9)).toBe('just now')
  })

  it('counts minutes, then hours', () => {
    expect(at(1)).toBe('1 min ago')
    expect(at(47)).toBe('47 min ago')
    expect(at(60)).toBe('an hour ago')
    expect(at(200)).toBe('3 hours ago')
  })

  it('does not go backwards on a clock that has', () => {
    // A box whose time jumped forward after an NTP sync hands back a
    // generatedAt in this device's future. "-3 min ago" reads as a bug.
    expect(reportAge(60_000, 0)).toBe('just now')
  })
})
