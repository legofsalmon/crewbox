// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Act } from '@crewbox/shared'
import { useAgenda } from './hooks.ts'

/**
 * The countdowns, after the phone has been in a pocket.
 *
 * The clock ticks every fifteen seconds, and a locked phone runs no ticks,
 * so on unlock the sidebar and the running order said who was on when the
 * phone was put away — and a show-log entry written in that moment was
 * stamped with that act.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

// Hoisted with the mock below, which runs before this module's own code.
const acts = vi.hoisted(() => {
  const slot = (id: string, name: string, start: string, end: string): Act => ({
    id,
    name,
    stage: 'Main',
    date: '2026-09-24',
    start,
    end,
    changeover: 0,
  })
  return [slot('a', 'The Openers', '19:00', '20:30'), slot('b', 'The Headliners', '20:45', '22:00')]
})

vi.mock('./store.ts', () => ({
  useTimetable: () => ({ snapshot: { acts }, loaded: true }),
}))

function OnNow() {
  const { stages } = useAgenda()
  return <p>{stages[0]?.onNow?.act.name ?? 'nobody'}</p>
}

let root: Root
let host: HTMLElement
let hidden = false

const lockAt = (time: string) => {
  // Locked, the page runs no timers at all: the clock moves and nothing
  // ticks. `setSystemTime` moves it without running any.
  hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  vi.setSystemTime(new Date(`2026-09-24T${time}:00`))
}

const unlock = () =>
  act(() => {
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
  })

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-09-24T20:00:00'))
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<OnNow />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  delete (document as { hidden?: boolean }).hidden
})

describe('the countdown after a phone is unlocked', () => {
  it('is right the moment the page is looked at', () => {
    expect(host.textContent).toBe('The Openers')
    lockAt('21:00')
    unlock()
    expect(host.textContent).toBe('The Headliners')
  })

  it('still ticks on its own while the page is open', () => {
    act(() => {
      vi.setSystemTime(new Date('2026-09-24T20:50:00'))
      vi.advanceTimersByTime(15_000)
    })
    expect(host.textContent).toBe('The Headliners')
  })

  it('stops listening once nothing shows it', () => {
    const removed = vi.spyOn(document, 'removeEventListener')
    act(() => root.unmount())
    expect(removed).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    root = createRoot(host)
  })
})
