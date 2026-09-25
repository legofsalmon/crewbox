// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store.ts'
import { forgetEventRecord, knownEvents } from '../lib/eventScope.ts'
import { resetSearchForTests } from '../lib/discovery.ts'
import { clearJoinLink, currentJoinLink, receiveLink } from '../lib/appLinks.ts'
import Join from './Join.tsx'

/**
 * A crewbox://join link at the app's join screen.
 *
 * Tapped in a message or on a phone's join page, it does what scanning the
 * poster does: the box's address and the event PIN go in, as if typed, and
 * Join is still somebody's to press. Nothing is sent anywhere on a link's
 * say-so.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let root: Root
let host: HTMLElement
const join = vi.fn(async () => {})
const fetched = vi.fn()

function inApp(platform: 'android' | 'ios'): void {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => platform, Plugins: {} }
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<Join />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
async function tapLink(url: string): Promise<void> {
  await act(async () => {
    receiveLink(url)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const field = (placeholder: string) =>
  host.querySelector<HTMLInputElement>(`input[placeholder^="${placeholder}"]`)!
const server = () => field('e.g. chat')
const eventPin = () => field('On the join poster')
const error = () => host.querySelector('.join-error')?.textContent ?? null
const note = () => host.querySelector('.join-scan-note')?.textContent ?? null
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
  clearJoinLink()
  join.mockClear()
  fetched.mockClear()
  vi.stubGlobal('fetch', fetched)
  useStore.setState({ join, boxesOpen: false })
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  resetSearchForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete window.Capacitor
  localStorage.clear()
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('a link that started the app', () => {
  it('fills in the box and the event PIN, asks for a name, and joins nothing', async () => {
    inApp('android')
    receiveLink('crewbox://join?server=192.168.8.1&pin=4821')
    await render()

    expect(server().value).toBe('192.168.8.1')
    expect(eventPin().value).toBe('4821')
    expect(note()).toBe('Filled in 192.168.8.1 and the event PIN from the link.')
    expect(error()).toBeNull()
    expect(document.activeElement?.getAttribute('placeholder')).toBe('e.g. Alex (Stage 2)')
    expect(currentJoinLink()).toBeNull()
    expect(join).not.toHaveBeenCalled()
    expect(fetched).not.toHaveBeenCalled()
  })
})

describe('a link tapped while the join screen is open', () => {
  it('fills in over what was there', async () => {
    inApp('android')
    await render()
    type(server(), '10.0.0.7')
    type(eventPin(), '1111')

    await tapLink('crewbox://join?server=192.168.8.1%3A3000&pin=4821')

    expect(server().value).toBe('192.168.8.1:3000')
    expect(eventPin().value).toBe('4821')
    expect(join).not.toHaveBeenCalled()
  })

  it('without a PIN leaves the PIN field alone and says where the PIN is', async () => {
    inApp('android')
    await render()
    type(eventPin(), '1111')

    await tapLink('crewbox://join?server=https%3A%2F%2Fchat.crew.example')

    expect(server().value).toBe('https://chat.crew.example')
    expect(eventPin().value).toBe('1111')
    expect(note()).toBe('Filled in chat.crew.example. The event PIN is on the join poster.')
  })

  it('closes Your boxes over the form, since the form is what it filled in', async () => {
    inApp('android')
    useStore.setState({ boxesOpen: true })
    await render()

    await tapLink('crewbox://join?server=192.168.8.1&pin=4821')

    expect(useStore.getState().boxesOpen).toBe(false)
    expect(server().value).toBe('192.168.8.1')
  })

  it('that isn’t a join link changes nothing', async () => {
    inApp('android')
    await render()
    type(server(), '10.0.0.7')

    await tapLink('crewbox://join?server=10.0.0.9%2Fadmin&pin=4821')
    await tapLink('https://10.0.0.9/?pin=4821')

    expect(server().value).toBe('10.0.0.7')
    expect(eventPin().value).toBe('')
    expect(note()).toBeNull()
  })
})

describe('on an iPhone', () => {
  it('fills in a plain-HTTP name, and says it needs HTTPS before Join is tried', async () => {
    inApp('ios')
    await render()
    await tapLink('crewbox://join?server=192.168.8.1&pin=1111')
    expect(note()).not.toBeNull()

    await tapLink('crewbox://join?server=crewbox.lan&pin=4821')

    expect(server().value).toBe('crewbox.lan')
    expect(eventPin().value).toBe('4821')
    expect(error()).toContain('An iPhone only connects to a name like crewbox.lan over HTTPS.')
    expect(note()).toBeNull()
  })
})

describe('in a phone’s browser', () => {
  const ANDROID_CHROME =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/129.0.0.0 Mobile Safari/537.36'
  const IPHONE_SAFARI =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  const openInApp = () => host.querySelector<HTMLAnchorElement>('a.join-app')

  it('on an iPhone, offers the app this box and the event PIN as typed', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_SAFARI)
    await render()

    expect(openInApp()?.textContent).toBe('Open in the Crewbox app')
    expect(openInApp()?.getAttribute('href')).toBe('crewbox://join?server=localhost%3A3000')
    type(eventPin(), '4821')
    expect(openInApp()?.getAttribute('href')).toBe(
      'crewbox://join?server=localhost%3A3000&pin=4821'
    )
  })

  it('on Android, as Chrome takes it, with the box’s /connect page for a phone without the app', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID_CHROME)
    await render()
    type(eventPin(), '4821')

    expect(openInApp()?.getAttribute('href')).toBe(
      'intent://join?server=localhost%3A3000&pin=4821#Intent;scheme=crewbox;' +
        'package=com.colmhewson.crewbox;' +
        'S.browser_fallback_url=http%3A%2F%2Flocalhost%3A3000%2Fconnect;end'
    )
  })

  it('is not offered on a computer, where there is no app to open', async () => {
    await render()
    expect(host.querySelector('form')).not.toBeNull()
    expect(openInApp()).toBeNull()
  })
})

describe('in the apps', () => {
  it('offers no link to themselves', async () => {
    inApp('android')
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; wv)')
    await render()
    type(server(), '192.168.8.1')
    type(eventPin(), '4821')
    expect(host.querySelector('a.join-app')).toBeNull()
  })
})
