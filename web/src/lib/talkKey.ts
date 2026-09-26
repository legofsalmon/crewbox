import { isTyping, type Shortcut } from '../shell/keys.ts'

/**
 * Hold Space to talk: the keyboard's version of the big button.
 *
 * Space is left alone when it already means something where it was pressed:
 * typing a space in the composer or a dialog, opening a focused dropdown, or
 * a handler further down (a lighting plot's fixture, say) that has claimed
 * it. Everywhere else it is the talk key, and both halves of the press are
 * swallowed so a focused button — Leave, most dangerously — isn't clicked
 * by it as well.
 *
 * Only a press that started here ends here: a Space released after typing a
 * space doesn't close a mic the button or the latch opened. And a release
 * never undoes the latch; the store already ignores `setTalking(false)`
 * while latched.
 */
export function talkKey(setTalking: (on: boolean) => void): Shortcut {
  let held = false
  return {
    key: ' ',
    when: (e) => !e.defaultPrevented && !isTyping(e.target) && !isDropdown(e.target),
    handler: (e) => {
      // Autorepeat while held. Not gated on `held`: a keyup lost to another
      // window mustn't leave the next press doing nothing.
      if (e.repeat) return
      held = true
      setTalking(true)
    },
    release: (e) => {
      if (!held) return
      held = false
      e.preventDefault()
      setTalking(false)
    },
  }
}

const isDropdown = (target: EventTarget | null) => target instanceof HTMLSelectElement
