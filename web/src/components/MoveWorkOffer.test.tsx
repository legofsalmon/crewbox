// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store.ts'
import {
  carriedOn,
  forgetEventRecord,
  knownEvent,
  knownEvents,
  rememberEvent,
} from '../lib/eventScope.ts'
import MoveWorkOffer from './MoveWork.tsx'

/**
 * When "Bring your work across?" asks by itself.
 *
 * Only on the word of the box's admin that it carries the event on, and not
 * over the admin panel, where that admin has only just said so, or over Your
 * boxes, whose row for the event offers the same thing. What a phone holds is
 * read from IndexedDB, which is stood in for here; the move itself is in
 * e2e/boxes.spec.ts.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

// This device is on the spare's event: the box that took over.
vi.hoisted(() => localStorage.setItem('crewbox:db-epoch', 'spare'))

const held = { documents: 2, acts: 0, unsentMessages: 1, unsentEntries: 0 }
vi.mock('../lib/moveWork.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/moveWork.ts')>()),
  movableOf: async () => held,
}))

let root: Root
let host: HTMLElement

/** Render, and let what the offer reads for itself come in. */
async function render(): Promise<void> {
  await act(async () => {
    root.render(<MoveWorkOffer />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const asking = () => host.querySelector('[role="dialog"][aria-label="Bring your work across?"]')

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  for (const event of knownEvents()) forgetEventRecord(event.id)
  rememberEvent({ id: 'spare', name: 'Harbour Fest', origin: 'http://10.0.0.9', seenAt: 3 })
  rememberEvent({ id: 'friday', name: 'Harbour Fest', origin: 'http://10.0.0.2', seenAt: 2 })
  useStore.setState({
    phase: 'chat',
    hasConnected: true,
    elsewhere: null,
    boxesOpen: false,
    adminOpen: false,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('asking to bring an event’s work across', () => {
  it('asks when the box’s admin says it carries the event on', async () => {
    carriedOn('friday', 'spare')
    await render()
    expect(asking()?.textContent).toContain(
      'This box carries on Harbour Fest, and this phone still has work from it:'
    )
  })

  it('doesn’t ask on a guess from the address alone', async () => {
    rememberEvent({ id: 'friday', replacedBy: 'spare' })
    await render()
    expect(asking()).toBeNull()
    expect(knownEvent('friday')?.moveAnswered).toBeUndefined()
  })

  it('waits for the admin panel to close, where its admin has just said so', async () => {
    useStore.setState({ adminOpen: true })
    carriedOn('friday', 'spare')
    await render()
    expect(asking()).toBeNull()
    act(() => useStore.setState({ adminOpen: false }))
    await settle()
    expect(asking()).not.toBeNull()
  })

  it('waits for Your boxes to close, whose row offers the same', async () => {
    useStore.setState({ boxesOpen: true })
    carriedOn('friday', 'spare')
    await render()
    expect(asking()).toBeNull()
    act(() => useStore.setState({ boxesOpen: false }))
    await settle()
    expect(asking()).not.toBeNull()
  })
})
