// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Continues } from '../lib/api.ts'
import { forgetEventRecord, knownEvents, rememberEvent } from '../lib/eventScope.ts'
import { ContinuesField } from './AdminPanel.tsx'

/**
 * Admin → This box: which event this box carries on.
 *
 * An admin can only name an event their device has been on, since an event's
 * ID is nothing anybody types, and the box running it is not one of them.
 * What the box keeps is shown to whichever admin's device reads it.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

// This device has the spare's event open: it is the box being set up.
vi.hoisted(() => localStorage.setItem('crewbox:db-epoch', 'spare'))

let root: Root
let host: HTMLElement
const onSave = vi.fn<(continues: Continues | null, note: string) => void>()

function render(saved: Continues | null | undefined, saving = false): void {
  act(() => root.render(<ContinuesField saved={saved} saving={saving} onSave={onSave} />))
}

const select = () => host.querySelector<HTMLSelectElement>('#admin-continues')!
const options = () => [...select().options].map((option) => option.textContent)
const save = () => host.querySelector<HTMLButtonElement>('button')!

function pick(value: string): void {
  act(() => {
    select().value = value
    select().dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  for (const event of knownEvents()) forgetEventRecord(event.id)
  rememberEvent({ id: 'spare', name: 'Harbour Fest', origin: 'http://10.0.0.9', seenAt: 4 })
  rememberEvent({ id: 'friday', name: 'Harbour Fest', origin: 'http://10.0.0.2:8787', seenAt: 2 })
  rememberEvent({ id: 'thursday', name: ' ', origin: 'http://10.0.0.4', seenAt: 3 })
  onSave.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('saying which event this box carries on', () => {
  it('offers the events this device has been on, latest first, and not the box’s own', () => {
    render(null)
    expect(options()).toEqual([
      'No, it’s a new event',
      'No name yet · 10.0.0.4',
      // The same name as the box's own event: the address tells them apart.
      'Harbour Fest · 10.0.0.2:8787',
    ])
    expect(select().value).toBe('')
    expect(save().disabled).toBe(true)
  })

  it('saves the one picked, by the name this device knows, and says what phones will do', () => {
    render(null)
    pick('friday')
    expect(save().disabled).toBe(false)
    act(() => save().click())
    expect(onSave).toHaveBeenCalledWith(
      { id: 'friday', name: 'Harbour Fest' },
      'Saved: phones that have Harbour Fest will offer to bring its work here'
    )
    pick('thursday')
    act(() => save().click())
    expect(onSave).toHaveBeenLastCalledWith(
      { id: 'thursday', name: '' },
      'Saved: phones that have No name yet will offer to bring its work here'
    )
  })

  it('clears it', () => {
    render({ id: 'friday', name: 'Harbour Fest' })
    expect(select().value).toBe('friday')
    expect(save().disabled).toBe(true)
    pick('')
    act(() => save().click())
    expect(onSave).toHaveBeenCalledWith(null, 'Saved: this box carries on no other event')
  })

  it('shows what the box keeps to a device that was never on that event', () => {
    render({ id: 'wednesday', name: 'Dock Party' })
    expect(options()).toContain('Dock Party')
    expect(select().value).toBe('wednesday')
    expect(save().disabled).toBe(true)
  })

  it('follows the box’s answer, and waits while it saves', () => {
    render(null)
    // Another admin's, when the panel reads the box again.
    render({ id: 'thursday', name: '' })
    expect(select().value).toBe('thursday')
    render(null)
    expect(select().value).toBe('')
    pick('friday')
    render({ id: 'friday', name: 'Harbour Fest' }, true)
    expect(select().disabled).toBe(true)
    expect(save().disabled).toBe(true)
    expect(save().textContent).toBe('Saving…')
    render({ id: 'friday', name: 'Harbour Fest' })
    expect(select().value).toBe('friday')
    expect(save().disabled).toBe(true)
  })

  it('isn’t there on a box too old to keep it', () => {
    render(undefined)
    expect(host.innerHTML).toBe('')
  })
})
