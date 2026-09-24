// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store.ts'
import { forgetEventRecord, knownEvents } from '../lib/eventScope.ts'
import { resetSearchForTests } from '../lib/discovery.ts'
import type { ScanOutcome, ScannerPlugin } from '../lib/server.ts'
import Join from './Join.tsx'

/**
 * The join screen's scanner, in the apps.
 *
 * The join poster's QR is the box's address with the event PIN, and scanning
 * it fills in both, as if they had been typed: Join then does what it does
 * for a typed address. Anything else the camera reads fills in nothing and
 * says what it was.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let root: Root
let host: HTMLElement
let answer: () => Promise<ScanOutcome>
const openSettings = vi.fn(async () => {})
const join = vi.fn(async () => {})

function inApp(platform: 'android' | 'ios', scanner = true): void {
  const plugin: ScannerPlugin = { scan: () => answer(), openSettings }
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: scanner ? { CrewboxScanner: plugin } : {},
  }
}

const scans = (outcome: ScanOutcome) => {
  answer = async () => outcome
}
const reads = (text: string) => scans({ result: 'scanned', text })

async function render(): Promise<void> {
  await act(async () => {
    root.render(<Join />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === name)
const field = (placeholder: string) =>
  host.querySelector<HTMLInputElement>(`input[placeholder^="${placeholder}"]`)!
const server = () => field('e.g. chat')
const eventPin = () => field('On the join poster')
const error = () => host.querySelector('.join-error')?.textContent ?? null
const note = () => host.querySelector('.join-scan-note')?.textContent ?? null
async function tap(el: HTMLElement | undefined): Promise<void> {
  expect(el).toBeDefined()
  await act(async () => {
    el!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const scan = () => tap(button('Scan the join poster'))
/** Types into a field as React sees it: through the value setter, then input. */
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
  answer = async () => ({ result: 'cancelled' })
  openSettings.mockClear()
  join.mockClear()
  useStore.setState({ join })
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  resetSearchForTests()
  delete window.Capacitor
  localStorage.clear()
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('where the scanner is offered', () => {
  it('is not in a browser, which is at its box already', async () => {
    await render()
    expect(button('Scan the join poster')).toBeUndefined()
  })

  it('is not in an app without a scanner', async () => {
    inApp('android', false)
    await render()
    expect(button('Scan the join poster')).toBeUndefined()
    expect(server()).not.toBeNull()
  })

  it('is in either app that has one', async () => {
    for (const platform of ['android', 'ios'] as const) {
      inApp(platform)
      await render()
      expect(button('Scan the join poster'), platform).toBeDefined()
      act(() => root.unmount())
      root = createRoot(host)
    }
  })
})

describe('scanning the join poster', () => {
  it('fills in the box’s address and the event PIN, then asks for a name', async () => {
    inApp('android')
    await render()
    reads('http://192.168.8.1/?pin=4821')

    await scan()

    expect(server().value).toBe('192.168.8.1')
    expect(eventPin().value).toBe('4821')
    expect(note()).toBe('Filled in 192.168.8.1 and the event PIN from the poster.')
    expect(error()).toBeNull()
    expect(document.activeElement?.getAttribute('placeholder')).toBe('e.g. Alex (Stage 2)')
  })

  it('keeps https:// for a box reached by the name on its certificate', async () => {
    inApp('ios')
    await render()
    reads('https://chat.crew.example/')

    await scan()

    expect(server().value).toBe('https://chat.crew.example')
    expect(eventPin().value).toBe('')
    expect(note()).toBe('Filled in chat.crew.example. The event PIN is on the join poster.')
  })

  it('joins at the scanned box with the scanned PIN', async () => {
    inApp('android')
    await render()
    reads('http://10.0.0.2:3000/?pin=4821')
    await scan()
    type(field('e.g. Alex'), 'Alex')
    type(field('4–8 digits'), '1234')

    await act(async () => {
      host.querySelector('form')!.requestSubmit()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(join).toHaveBeenCalledWith('Alex', '4821', '1234')
    expect(localStorage.getItem('crewbox:server-url')).toBe('http://10.0.0.2:3000')
  })

  it('says a plain-HTTP name won’t work on an iPhone, as a typed one would', async () => {
    inApp('ios')
    await render()
    reads('http://crew.example.org/?pin=4821')

    await scan()

    expect(server().value).toBe('crew.example.org')
    expect(error()).toContain('An iPhone only connects to a name like crew.example.org over HTTPS')
    expect(note()).toBeNull()
  })
})

describe('what else the camera might read', () => {
  it('names a Wi-Fi code’s network and fills in nothing', async () => {
    inApp('android')
    await render()
    reads('WIFI:T:WPA;S:Crew Net;P:secret;;')

    await scan()

    expect(server().value).toBe('')
    expect(error()).toBe(
      'That code is for the Wi-Fi, Crew Net. Join it with this phone’s camera or its Wi-Fi ' +
        'settings, then scan the crew code on the join poster.'
    )
  })

  it('says anything else isn’t the crew code', async () => {
    inApp('android')
    await render()
    reads('https://example.com/menu')

    await scan()

    expect(server().value).toBe('')
    expect(eventPin().value).toBe('')
    expect(error()).toBe(
      'That isn’t the crew code. Scan the QR on the join poster, or type the address under it.'
    )
  })
})

describe('when the scan does not happen', () => {
  it('leaves everything as it was when backed out of', async () => {
    inApp('android')
    await render()
    reads('http://192.168.8.1/?pin=4821')
    await scan()
    scans({ result: 'cancelled' })

    await scan()

    expect(server().value).toBe('192.168.8.1')
    expect(error()).toBeNull()
  })

  it('points to Settings when the camera isn’t allowed', async () => {
    inApp('ios')
    await render()
    scans({ result: 'denied' })

    await scan()

    expect(error()).toContain('Switch on Camera for Crewbox in Settings')
    await tap(button('Open Settings'))
    expect(openSettings).toHaveBeenCalledOnce()

    // A scan that works puts the way to Settings away.
    reads('http://192.168.8.1/?pin=4821')
    await scan()
    expect(button('Open Settings')).toBeUndefined()
  })

  it('says a phone that can’t scan should type the address', async () => {
    inApp('android')
    await render()
    scans({ result: 'unavailable' })

    await scan()

    expect(error()).toBe('This phone can’t scan codes. Type the address from the join poster.')
    expect(button('Open Settings')).toBeUndefined()
  })

  it('says the camera didn’t start when the scanner fails', async () => {
    inApp('android')
    await render()
    answer = async () => {
      throw new Error('camera in use')
    }

    await scan()

    expect(error()).toBe(
      'The camera didn’t start. Try again, or type the address from the join poster.'
    )
  })
})
