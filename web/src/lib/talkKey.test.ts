// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerShortcut } from '../shell/keys.ts'
import { talkKey } from './talkKey.ts'

/** Holding Space is the keyboard's version of holding the talk button. */

let unregister = () => {}
afterEach(() => {
  unregister()
  document.body.innerHTML = ''
})

const setup = () => {
  const setTalking = vi.fn()
  unregister = registerShortcut(talkKey(setTalking))
  return setTalking
}

const key = (type: 'keydown' | 'keyup', target: EventTarget = document.body, init = {}) => {
  const e = new KeyboardEvent(type, { key: ' ', bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

const add = <K extends keyof HTMLElementTagNameMap>(tag: K) => {
  const el = document.createElement(tag)
  document.body.append(el)
  return el
}

describe('hold Space to talk', () => {
  it('opens the mic on press and closes it on release', () => {
    const setTalking = setup()
    expect(key('keydown').defaultPrevented).toBe(true)
    expect(setTalking).toHaveBeenLastCalledWith(true)
    expect(key('keyup').defaultPrevented).toBe(true)
    expect(setTalking).toHaveBeenLastCalledWith(false)
    expect(setTalking).toHaveBeenCalledTimes(2)
  })

  it('ignores autorepeat while the key is held', () => {
    const setTalking = setup()
    key('keydown')
    key('keydown', document.body, { repeat: true })
    key('keydown', document.body, { repeat: true })
    expect(setTalking).toHaveBeenCalledTimes(1)
  })

  it('swallows the press on a focused button, so Space never clicks Leave', () => {
    const setTalking = setup()
    const leave = add('button')
    expect(key('keydown', leave).defaultPrevented).toBe(true)
    expect(key('keyup', leave).defaultPrevented).toBe(true)
    expect(setTalking.mock.calls).toEqual([[true], [false]])
  })

  it.each([
    ['the composer', () => add('textarea')],
    ['a text field', () => add('input')],
    ['a dropdown', () => add('select')],
    [
      'something editable',
      () => {
        const div = add('div')
        div.contentEditable = 'true'
        return div
      },
    ],
  ])('leaves Space alone in %s', (_, make) => {
    const setTalking = setup()
    const field = make()
    expect(key('keydown', field).defaultPrevented).toBe(false)
    // The release of a space somebody typed is not the end of a talk press:
    // it must not close a mic the button or the latch opened.
    expect(key('keyup', field).defaultPrevented).toBe(false)
    expect(setTalking).not.toHaveBeenCalled()
  })

  it('leaves Space alone when something on the page has already claimed it', () => {
    const setTalking = setup()
    const fixture = add('div')
    fixture.addEventListener('keydown', (e) => e.preventDefault())
    key('keydown', fixture)
    key('keyup', fixture)
    expect(setTalking).not.toHaveBeenCalled()
  })

  it('works again after a release it never saw', () => {
    // Space let go in another window: the next press still talks.
    const setTalking = setup()
    key('keydown')
    key('keydown')
    expect(setTalking.mock.calls).toEqual([[true], [true]])
  })

  it('does nothing once unregistered', () => {
    const setTalking = setup()
    unregister()
    expect(key('keydown').defaultPrevented).toBe(false)
    key('keyup')
    expect(setTalking).not.toHaveBeenCalled()
  })

  it('is not taken with a modifier held', () => {
    const setTalking = setup()
    key('keydown', document.body, { ctrlKey: true })
    key('keydown', document.body, { shiftKey: true })
    expect(setTalking).not.toHaveBeenCalled()
  })
})
