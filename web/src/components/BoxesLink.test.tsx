// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicConfig } from '@crewbox/shared'
import { useStore } from '../store.ts'
import { resetSearchForTests } from '../lib/discovery.ts'
import { forgetEventRecord, knownEvents } from '../lib/eventScope.ts'
import { clearJoinLink, currentJoinLink, receiveLink } from '../lib/appLinks.ts'
import Boxes from './Boxes.tsx'

/**
 * A crewbox://join link for another box, tapped on a phone signed in to one.
 *
 * The app opens Your boxes for it (App.tsx). The link's address is put where
 * an address is typed, ready to Connect, and nothing is asked of the box until
 * somebody does: then it goes as a typed address goes, taking the link's event
 * PIN to that box's join form.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let root: Root
let host: HTMLElement
let asked: string[]
const openEventAt = vi.fn()

const config = (fields: Partial<PublicConfig>): PublicConfig => ({
  eventName: '',
  wifiSsid: '',
  voiceEnabled: false,
  modules: [],
  ...fields,
})

function boxesAnswer(answer: PublicConfig): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url)
      return new Response(JSON.stringify(answer), { status: 200 })
    })
  )
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<Boxes />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
async function tapLink(url: string): Promise<void> {
  await act(async () => {
    receiveLink(url)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const address = () => host.querySelector<HTMLInputElement>('#boxes-address')!
const hint = () => host.querySelector('.boxes-address .hint')?.textContent ?? null
async function connect(): Promise<void> {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (el) => el.textContent === 'Connect'
  )
  expect(button).toBeDefined()
  await act(async () => {
    button!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
function type(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  for (const event of knownEvents()) forgetEventRecord(event.id)
  localStorage.clear()
  localStorage.setItem('crewbox:db-epoch', 'friday')
  clearJoinLink()
  asked = []
  boxesAnswer(config({ eventId: 'saturday', eventName: 'Quay Sessions' }))
  openEventAt.mockClear()
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} }
  useStore.setState({ openEventAt, phase: 'chat', boxesOpen: true })
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  resetSearchForTests()
  vi.unstubAllGlobals()
  delete window.Capacitor
  localStorage.clear()
  useStore.setState({ phase: 'boot', boxesOpen: false })
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('a link for another box, while signed in', () => {
  it('puts its address ready to Connect, and asks nothing of the box yet', async () => {
    receiveLink('crewbox://join?server=10.0.0.9&pin=4821')
    await render()

    expect(address().value).toBe('10.0.0.9')
    expect(hint()).toBe('From the link. Connect to open it.')
    expect(currentJoinLink()).toBeNull()
    expect(asked).toEqual([])
    expect(openEventAt).not.toHaveBeenCalled()
  })

  it('opens that box’s event on Connect, with the link’s event PIN for its join form', async () => {
    await render()
    await tapLink('crewbox://join?server=10.0.0.9&pin=4821')

    await connect()

    expect(asked).toEqual(['http://10.0.0.9/api/config'])
    expect(openEventAt).toHaveBeenCalledWith({
      id: 'saturday',
      name: 'Quay Sessions',
      origin: 'http://10.0.0.9',
      pin: '4821',
    })
  })

  it('keeps the PIN to the link’s own box: another address typed over it goes without', async () => {
    await render()
    await tapLink('crewbox://join?server=10.0.0.9&pin=4821')
    type(address(), '10.0.0.5')
    expect(hint()).toBe('Its address, from the join poster')

    await connect()

    expect(openEventAt).toHaveBeenCalledWith({
      id: 'saturday',
      name: 'Quay Sessions',
      origin: 'http://10.0.0.5',
    })
  })
})

describe('Your boxes over the join form', () => {
  it('leaves a link to the form, which fills itself in', async () => {
    useStore.setState({ phase: 'join' })
    await render()
    await tapLink('crewbox://join?server=10.0.0.9&pin=4821')

    expect(address().value).toBe('')
    expect(currentJoinLink()).not.toBeNull()
  })
})
