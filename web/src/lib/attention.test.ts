import { describe, expect, it } from 'vitest'
import { looking } from './attention.ts'

/**
 * A cleared badge cannot be un-cleared — there is no "mark unread" — so the
 * only interesting question is which states are allowed to clear one.
 */

const doc = (hasFocus: boolean, hidden: boolean) => ({ hasFocus: () => hasFocus, hidden })

describe('whether anybody is looking', () => {
  it('yes, when the window has focus and is on screen', () => {
    expect(looking(doc(true, false))).toBe(true)
  })

  it('no, for a backgrounded tab', () => {
    // The case the store already guarded on the incoming-message path; the
    // scroll handler went around it, and a browser restoring its own scroll
    // position on load fires a scroll with nobody there.
    expect(looking(doc(false, false))).toBe(false)
  })

  it('no, for a phone with its screen off', () => {
    // The half that `hasFocus()` alone misses: the page is still its
    // window's focused document, so focus says yes while the phone is in
    // somebody's pocket. `hidden` is what tells the truth there.
    expect(looking(doc(true, true))).toBe(false)
  })

  it('no, for both at once', () => {
    expect(looking(doc(false, true))).toBe(false)
  })
})
