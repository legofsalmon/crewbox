// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VideoMain from './VideoMain.tsx'
import { fetchVideoState } from './model/api.ts'

/**
 * The LED walls pane, after the phone has been in a pocket.
 *
 * The pane polls every ten seconds, but not while the page is hidden, so a
 * phone coming back from the lock screen showed the walls as they were when
 * it was locked, for up to ten seconds, at exactly the moment somebody had
 * taken it out to look.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

vi.mock('./model/api.ts', () => ({
  // Never answers: what is asked, and when, is all this is about.
  fetchVideoState: vi.fn(() => new Promise(() => {})),
  addProcessor: vi.fn(),
  raiseIntent: vi.fn(),
  removeProcessor: vi.fn(),
  runScan: vi.fn(),
  setWatching: vi.fn(),
}))

let root: Root
let host: HTMLElement
let hidden = false

const setHidden = (value: boolean) =>
  act(() => {
    hidden = value
    document.dispatchEvent(new Event('visibilitychange'))
  })

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.mocked(fetchVideoState).mockClear()
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<VideoMain subpath="" />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  delete (document as { hidden?: boolean }).hidden
})

describe('the LED walls pane', () => {
  it('asks the box again the moment the phone is unlocked', () => {
    expect(fetchVideoState).toHaveBeenCalledTimes(1)
    setHidden(true)
    // Locked for a minute: the poll runs and asks nothing.
    act(() => vi.advanceTimersByTime(60_000))
    expect(fetchVideoState).toHaveBeenCalledTimes(1)
    setHidden(false)
    expect(fetchVideoState).toHaveBeenCalledTimes(2)
  })

  it('keeps polling while it is on screen', () => {
    act(() => vi.advanceTimersByTime(10_000))
    expect(fetchVideoState).toHaveBeenCalledTimes(2)
  })

  it('stops asking once it is closed', () => {
    act(() => root.unmount())
    setHidden(true)
    setHidden(false)
    act(() => vi.advanceTimersByTime(60_000))
    expect(fetchVideoState).toHaveBeenCalledTimes(1)
    root = createRoot(host)
  })
})
