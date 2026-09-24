// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicConfig } from '@crewbox/shared'
import { useStore } from '../store.ts'
import { checkFound, type FoundBox } from '../lib/boxes.ts'
import { ASKED_KEY, resetSearchForTests, type NearbyBox } from '../lib/discovery.ts'
import {
  forgetEventRecord,
  knownEvents,
  rememberEvent,
  type KnownEvent,
} from '../lib/eventScope.ts'
import type { DiscoveryPlugin, FoundService } from '../lib/server.ts'
import Boxes from './Boxes.tsx'
import Join from './Join.tsx'

/**
 * Boxes on this Wi-Fi, on the join screen and the Boxes screen.
 *
 * A found box is listed as it announces itself, and picked as it answers for
 * itself: the box's own /api/config decides what this device does next, and
 * a box claiming an event this device holds elsewhere is refused, whatever
 * its announcement said.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

const box = (fields: Partial<NearbyBox> = {}): NearbyBox => ({
  key: 'Harbour Fest',
  origin: 'http://192.168.8.1:8080',
  address: '192.168.8.1:8080',
  eventId: 'saturday',
  eventName: 'Harbour Fest',
  setUp: true,
  lookalike: false,
  ...fields,
})

const answering = (found: FoundBox) => async (): Promise<FoundBox> => found

const holding =
  (...events: KnownEvent[]) =>
  (id: string) =>
    events.find((event) => event.id === id)

describe('picking a found box', () => {
  it('goes by what the box itself says, not what it announced', async () => {
    const result = await checkFound(
      box({ eventName: 'Announced name' }),
      answering({
        kind: 'event',
        origin: 'http://192.168.8.1:8080',
        id: 'saturday',
        name: 'Harbour Fest',
      }),
      holding()
    )
    expect(result).toEqual({
      ok: true,
      box: { id: 'saturday', name: 'Harbour Fest', origin: 'http://192.168.8.1:8080' },
    })
  })

  it('refuses a box answering as an event this device holds at another address', async () => {
    const result = await checkFound(
      box({ eventId: 'impostor' }),
      answering({ kind: 'event', origin: 'http://192.168.8.1:8080', id: 'friday', name: 'Fri' }),
      holding({ id: 'friday', name: 'Quay Stage', origin: 'http://10.0.0.2', seenAt: 1 })
    )
    expect(result).toEqual({
      ok: false,
      message:
        'The box at 192.168.8.1:8080 says it runs Quay Stage, which this phone knows at ' +
        '10.0.0.2. If that box has moved, type its new address from the join poster.',
    })
  })

  it('takes an event this device holds at the address it knows it by', async () => {
    const result = await checkFound(
      box(),
      answering({ kind: 'event', origin: 'http://192.168.8.1:8080', id: 'friday', name: 'Fri' }),
      holding({ id: 'friday', name: 'Fri', origin: 'http://192.168.8.1:8080', seenAt: 1 })
    )
    expect(result.ok).toBe(true)
  })

  it('says what went wrong when the box does not answer, or cannot say its event', async () => {
    const gone = await checkFound(
      box(),
      answering({ kind: 'unreachable', origin: 'http://192.168.8.1:8080' }),
      holding()
    )
    expect(gone).toMatchObject({ ok: false, message: expect.stringContaining('192.168.8.1:8080') })
    const old = await checkFound(
      box(),
      answering({ kind: 'too-old', origin: 'http://192.168.8.1:8080' }),
      holding()
    )
    expect(old).toMatchObject({ ok: false, message: expect.stringContaining('older crewbox') })
  })
})

// ---------------------------------------------------------------------------

function fakePlugin() {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
    addListener(event: string, listener: (event: unknown) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return { remove: () => set.delete(listener) }
    },
    emit(event: 'boxes' | 'state', data: unknown) {
      act(() => {
        for (const listener of listeners.get(event) ?? []) listener(data)
      })
    },
  }
}

const service = (fields: Partial<FoundService> = {}): FoundService => ({
  name: 'Harbour Fest',
  addresses: ['192.168.8.1'],
  port: 8080,
  txt: { txtvers: '1', id: 'saturday', name: 'Harbour Fest', setup: '1' },
  ...fields,
})

const config = (fields: Partial<PublicConfig>): PublicConfig => ({
  eventName: '',
  wifiSsid: '',
  voiceEnabled: false,
  modules: [],
  ...fields,
})

let plugin: ReturnType<typeof fakePlugin>
let root: Root
let host: HTMLElement
let asked: string[]
const openEventAt = vi.fn()

function inApp(platform: 'android' | 'ios'): void {
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: { CrewboxDiscovery: plugin as unknown as DiscoveryPlugin },
  }
}

/** Every box answers /api/config with this, and the address asked is noted. */
function boxesAnswer(answer: PublicConfig): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url)
      return new Response(JSON.stringify(answer), { status: 200 })
    })
  )
}

/** Render, and let what the screen reads for itself (the Boxes screen's holdings) come in. */
async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const section = () => host.querySelector<HTMLElement>('[aria-label="Boxes on this Wi-Fi"]')
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (el) => (el.getAttribute('aria-label') ?? el.textContent) === name
  )
async function tap(el: HTMLElement | undefined): Promise<void> {
  expect(el).toBeDefined()
  await act(async () => {
    el!.click()
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // The list of events is cached beside localStorage: empty both.
  for (const event of knownEvents()) forgetEventRecord(event.id)
  localStorage.clear()
  localStorage.setItem('crewbox:db-epoch', 'friday')
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  plugin = fakePlugin()
  asked = []
  openEventAt.mockClear()
  useStore.setState({ openEventAt })
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('the join screen', () => {
  it('has no list in a browser, which is at its box already', async () => {
    await render(<Join />)
    expect(section()).toBeNull()
  })

  it('fills in the address of a box picked from the list, once the box has said who it is', async () => {
    inApp('android')
    await render(<Join />)
    expect(section()?.textContent).toContain('Looking for boxes on this Wi-Fi')
    plugin.emit('boxes', { boxes: [service()] })
    boxesAnswer(config({ eventId: 'saturday', eventName: 'Harbour Fest' }))

    await tap(button('Pick Harbour Fest'))

    expect(asked).toEqual(['http://192.168.8.1:8080/api/config'])
    const server = host.querySelector<HTMLInputElement>('input[placeholder^="e.g. chat"]')!
    expect(server.value).toBe('192.168.8.1:8080')
    expect(section()?.textContent).toContain('Picked')
    // Next is the crew member's name.
    expect(document.activeElement?.getAttribute('placeholder')).toBe('e.g. Alex (Stage 2)')
  })

  it('refuses a box that turns out to claim an event this phone knows somewhere else', async () => {
    rememberEvent({ id: 'friday', name: 'Quay Stage', origin: 'http://10.0.0.2', seenAt: 1 })
    inApp('android')
    await render(<Join />)
    plugin.emit('boxes', { boxes: [service()] })
    boxesAnswer(config({ eventId: 'friday', eventName: 'Quay Stage' }))

    await tap(button('Pick Harbour Fest'))

    const server = host.querySelector<HTMLInputElement>('input[placeholder^="e.g. chat"]')!
    expect(server.value).toBe('')
    expect(section()?.textContent).toContain('which this phone knows at 10.0.0.2')
  })
})

describe('the Boxes screen', () => {
  it('opens a found box’s event with what the box itself answered', async () => {
    inApp('android')
    await render(<Boxes />)
    plugin.emit('boxes', { boxes: [service()] })
    boxesAnswer(config({ eventId: 'saturday', eventName: 'Harbour Fest' }))

    await tap(button('Join Harbour Fest'))

    expect(openEventAt).toHaveBeenCalledWith({
      id: 'saturday',
      name: 'Harbour Fest',
      origin: 'http://192.168.8.1:8080',
    })
  })

  it('says which of this device’s events have their box here', async () => {
    rememberEvent({ id: 'saturday', name: 'Harbour Fest', origin: 'http://192.168.8.1:8080' })
    inApp('android')
    await render(<Boxes />)
    plugin.emit('boxes', { boxes: [service()] })
    const row = host.querySelector('[aria-label="Events on this device"] li')
    expect(row?.textContent).toContain('On this Wi-Fi')
    // And it is not listed a second time, as a box to join.
    expect(button('Join Harbour Fest')).toBeUndefined()
  })

  it('offers nothing to join on a box nobody has set up, and says how', async () => {
    inApp('android')
    await render(<Boxes />)
    plugin.emit('boxes', { boxes: [service({ txt: { id: 'fresh', setup: '0' } })] })
    expect(button('Join No name yet')).toBeUndefined()
    expect(section()?.textContent).toContain('Open 192.168.8.1:8080/setup in a browser')
  })

  it('warns when two boxes here have the same name', async () => {
    inApp('android')
    await render(<Boxes />)
    plugin.emit('boxes', {
      boxes: [
        service(),
        service({ addresses: ['10.6.6.6'], txt: { id: 'x', name: 'Harbour Fest' } }),
      ],
    })
    expect(section()?.textContent).toContain('Another box here has the same name')
  })

  it('on an iPhone, asks first, and starts looking on a tap', async () => {
    inApp('ios')
    await render(<Boxes />)
    expect(section()?.textContent).toContain('Your iPhone will ask')
    expect(plugin.start).not.toHaveBeenCalled()
    await tap(button('Find boxes'))
    expect(plugin.start).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(ASKED_KEY)).toBe('1')
  })

  it('on an iPhone that said no, points to Settings', async () => {
    localStorage.setItem(ASKED_KEY, '1')
    inApp('ios')
    await render(<Boxes />)
    plugin.emit('state', { state: 'denied' })
    expect(section()?.textContent).toContain('Switch on Local Network')
    await tap(button('Open Settings'))
    expect(plugin.openSettings).toHaveBeenCalledTimes(1)
  })
})
