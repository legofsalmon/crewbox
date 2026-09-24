// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ASKED_KEY,
  nearby,
  originOf,
  QUIET_AFTER_MS,
  resetSearchForTests,
  searchNow,
  servicesFrom,
  useBoxSearch,
  type Search,
} from './discovery.ts'
import type { KnownEvent } from './eventScope.ts'
import type { DiscoveryPlugin, FoundService } from './server.ts'

/**
 * Boxes on this Wi-Fi, as the apps find them.
 *
 * The native side does the looking (NWBrowser, NsdManager) and hands over
 * what it found; this is what the page makes of it. An announcement is
 * anybody's to make, so the rules pinned here are about what it is trusted
 * with: where a listed box is reached, and which events it may never stand
 * in for.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

const service = (fields: Partial<FoundService> = {}): FoundService => ({
  name: 'Harbour Fest',
  addresses: ['192.168.8.1'],
  port: 80,
  txt: { txtvers: '1', id: 'saturday', name: 'Harbour Fest', setup: '1' },
  ...fields,
})

const known = (fields: Partial<KnownEvent> & { id: string }): KnownEvent => ({
  name: '',
  origin: '',
  seenAt: 0,
  ...fields,
})

describe('where a found box is reached', () => {
  it('is its IPv4 address over plain HTTP, with the port when it is not 80', () => {
    expect(originOf(service())).toBe('http://192.168.8.1')
    expect(originOf(service({ port: 8080 }))).toBe('http://192.168.8.1:8080')
  })

  it('skips addresses that are not IPv4, and ones a URL would read differently', () => {
    expect(originOf(service({ addresses: ['fe80::1', 'box.local', '10.0.0.2'] }))).toBe(
      'http://10.0.0.2'
    )
    // A leading zero is octal to a URL: 010.0.0.2 is 8.0.0.2.
    for (const odd of ['010.0.0.2', '256.1.1.1', '10.0.0', '10.0.0.2.5', ' 10.0.0.2']) {
      expect(originOf(service({ addresses: [odd] })), odd).toBeNull()
    }
  })

  const tls = (value: string, port = 443) =>
    originOf(service({ port, txt: { ...service().txt, tls: value } }))

  it('is the name on its certificate over HTTPS, when it has one', () => {
    expect(tls('crew.example')).toBe('https://crew.example')
    expect(tls('Crew.Example', 8443)).toBe('https://crew.example:8443')
    // Named, so no address is needed.
    expect(
      originOf(service({ port: 443, addresses: [], txt: { id: 'saturday', tls: 'crew.example' } }))
    ).toBe('https://crew.example')
  })

  it('is its address over HTTPS for a certificate with no name, and for one it cannot use', () => {
    expect(tls('')).toBe('https://192.168.8.1')
    expect(tls('', 8443)).toBe('https://192.168.8.1:8443')
    // Whatever else is written there goes nowhere near a URL.
    for (const odd of ['crew.example/x', 'user@crew.example', 'crew example', 'crew.example:1']) {
      expect(tls(odd), odd).toBe('https://192.168.8.1')
    }
  })

  it('is nowhere without an address, or with a port that is not one', () => {
    expect(originOf(service({ addresses: [] }))).toBeNull()
    expect(originOf(service({ port: 0 }))).toBeNull()
    expect(originOf(service({ port: 65536 }))).toBeNull()
  })
})

describe('what the list shows', () => {
  it('lists a box running an event this device does not hold, as it says it is', () => {
    const { boxes, here } = nearby([service({ port: 8080 })], [])
    expect(boxes).toEqual([
      {
        key: 'Harbour Fest',
        origin: 'http://192.168.8.1:8080',
        address: '192.168.8.1:8080',
        eventId: 'saturday',
        eventName: 'Harbour Fest',
        setUp: true,
        lookalike: false,
      },
    ])
    expect(here.size).toBe(0)
  })

  it('marks an event this device holds as here, when it is at the address it knows', () => {
    const { boxes, here } = nearby(
      [service()],
      [known({ id: 'saturday', origin: 'http://192.168.8.1' })]
    )
    expect(boxes).toEqual([])
    expect([...here]).toEqual(['saturday'])
  })

  it('never lists an event this device holds at another address', () => {
    // Anything can announce a known event's ID. Following it there takes the
    // box proving it with the key kept at join, which a listing cannot do.
    const { boxes, here } = nearby(
      [service({ addresses: ['10.6.6.6'] })],
      [known({ id: 'saturday', origin: 'http://192.168.8.1' })]
    )
    expect(boxes).toEqual([])
    expect(here.size).toBe(0)
  })

  it('shows a box once, however many times it is announced', () => {
    const { boxes } = nearby(
      [service(), service({ name: 'Harbour Fest (2)' }), service({ addresses: ['192.168.8.1'] })],
      []
    )
    expect(boxes).toHaveLength(1)
  })

  it('warns when two boxes go by the same event or the same name', () => {
    const { boxes } = nearby(
      [
        service(),
        service({
          name: 'Other',
          addresses: ['10.0.0.9'],
          txt: { id: 'impostor', name: 'harbour fest ' },
        }),
        service({ name: 'Copy', addresses: ['10.0.0.10'], txt: { id: 'saturday', name: 'Copy' } }),
        service({
          name: 'Quay',
          addresses: ['10.0.0.11'],
          txt: { id: 'quay', name: 'Quay Stage' },
        }),
      ],
      []
    )
    const flagged = Object.fromEntries(boxes.map((box) => [box.address, box.lookalike]))
    expect(flagged).toEqual({
      '192.168.8.1': true,
      '10.0.0.9': true,
      '10.0.0.10': true,
      '10.0.0.11': false,
    })
  })

  it('says which boxes nobody has set up yet', () => {
    const { boxes } = nearby([service({ txt: { id: 'fresh', setup: '0' } })], [])
    expect(boxes[0]).toMatchObject({ setUp: false, eventName: '' })
  })

  it('says which event of this device’s a box carries on, by the name this device knows', () => {
    const carries = (continues: string) =>
      nearby(
        [service({ addresses: ['10.0.0.9'], txt: { ...service().txt, id: 'spare', continues } })],
        [
          known({ id: 'friday', name: ' Harbour Fest ', origin: 'http://10.0.0.2' }),
          known({ id: 'thursday', origin: 'http://10.0.0.4' }),
        ]
      ).boxes[0]?.carries
    expect(carries('friday')).toBe('Harbour Fest')
    expect(carries('thursday')).toBe('')
    // An event this device never had, or no event at all, says nothing: a
    // box may claim anything, and its name here would be the box's word.
    expect(carries('wednesday')).toBeUndefined()
    expect(carries('../friday')).toBeUndefined()
    expect(carries('')).toBeUndefined()
  })

  it('lists a box whose announced ID could not be an event, for the box itself to answer', () => {
    const { boxes } = nearby([service({ txt: { id: 'not/an:id', name: 'Odd' } })], [])
    expect(boxes[0]).toMatchObject({ eventId: undefined, eventName: 'Odd' })
  })

  it('sorts by name, then address as numbers', () => {
    const at = (address: string, name: string) =>
      service({
        name: `${name} ${address}`,
        addresses: [address],
        txt: { id: address.replaceAll('.', '_'), name },
      })
    const { boxes } = nearby([at('10.0.0.10', 'b'), at('10.0.0.9', 'b'), at('10.0.0.200', 'A')], [])
    expect(boxes.map((box) => box.address)).toEqual(['10.0.0.200', '10.0.0.9', '10.0.0.10'])
  })

  it('lists the boxes crew can join before any nobody has set up', () => {
    // A fresh box has no name yet, which would sort it first by name.
    const fresh = service({ name: 'crewbox', addresses: ['10.0.0.5'], txt: { setup: '0' } })
    const set = service({
      name: 'Fest',
      addresses: ['10.0.0.9'],
      txt: { id: 'fest', name: 'Fest' },
    })
    const { boxes } = nearby([fresh, set], [])
    expect(boxes.map((box) => [box.address, box.setUp])).toEqual([
      ['10.0.0.9', true],
      ['10.0.0.5', false],
    ])
  })
})

describe('what the native side sends', () => {
  it('keeps what makes sense and drops the rest', () => {
    expect(servicesFrom(undefined)).toEqual([])
    expect(servicesFrom({ boxes: [] })).toEqual([])
    expect(
      servicesFrom([
        null,
        'box',
        { name: 'No port', addresses: [], txt: {} },
        { name: 'Bad port', addresses: [], port: 99999, txt: {} },
        { name: 5, addresses: [], port: 80, txt: {} },
        { name: 'No addresses', port: 80, txt: {} },
        {
          name: 'Harbour Fest',
          addresses: ['192.168.8.1', 7, null],
          port: 80,
          txt: { ID: 'saturday', name: 'Harbour Fest', junk: 3 },
        },
      ])
    ).toEqual([
      {
        name: 'Harbour Fest',
        addresses: ['192.168.8.1'],
        port: 80,
        txt: { id: 'saturday', name: 'Harbour Fest' },
      },
    ])
  })
})

// ---------------------------------------------------------------------------

/** The native side, as the page sees it through the bridge. */
function fakePlugin() {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const plugin = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
    addListener(event: string, listener: (event: unknown) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return { remove: () => set.delete(listener) }
    },
    /** What the native side says next. */
    emit(event: 'boxes' | 'state', data: unknown) {
      act(() => {
        for (const listener of listeners.get(event) ?? []) listener(data)
      })
    },
    listening: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  }
  return plugin
}

let plugin: ReturnType<typeof fakePlugin>
let root: Root
let seen: Search

function inApp(platform: 'android' | 'ios'): void {
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: { CrewboxDiscovery: plugin as unknown as DiscoveryPlugin },
  }
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  seen = useBoxSearch(enabled)
  return null
}

/** Screens using the search: the same ones stay mounted from one call to the next. */
const mount = (count = 1): void =>
  act(() =>
    root.render(
      createElement(
        'div',
        null,
        Array.from({ length: count }, (_, i) => createElement(Probe, { key: i }))
      )
    )
  )

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  plugin = fakePlugin()
  root = createRoot(document.createElement('div'))
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

afterEach(() => {
  act(() => root.unmount())
  resetSearchForTests()
  vi.useRealTimers()
  delete window.Capacitor
  localStorage.clear()
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('the search', () => {
  it('does not exist in a browser, which cannot look', () => {
    mount()
    expect(seen.state).toBe('off')
    expect(plugin.start).not.toHaveBeenCalled()
  })

  it('runs in the Android app while a screen wants it, and stops when none does', () => {
    inApp('android')
    mount(2)
    expect(plugin.start).toHaveBeenCalledTimes(1)
    expect(seen.state).toBe('searching')

    plugin.emit('boxes', { boxes: [service()] })
    expect(seen.services).toEqual([service()])

    mount(1)
    expect(plugin.stop).not.toHaveBeenCalled()
    act(() => root.render(null))
    expect(plugin.stop).toHaveBeenCalledTimes(1)
    expect(plugin.listening()).toBe(0)
  })

  it('starts afresh each time, with nothing left over from the last', () => {
    inApp('android')
    mount()
    plugin.emit('boxes', { boxes: [service()] })
    act(() => root.render(null))
    mount()
    expect(plugin.start).toHaveBeenCalledTimes(2)
    expect(seen).toEqual({ state: 'searching', services: [], quiet: false })
  })

  it('takes no notice of the native side once it has stopped', () => {
    inApp('android')
    // A bridge slow to drop a listener still delivers what was on its way.
    const add = plugin.addListener
    plugin.addListener = (event, listener) => {
      add(event, listener)
      return { remove: () => true }
    }
    mount()
    setVisibility('hidden')
    plugin.emit('boxes', { boxes: [service()] })
    plugin.emit('state', { state: 'failed' })
    expect(seen.services).toEqual([])
    expect(seen.state).toBe('searching')
  })

  it('stops while the app is out of sight, and looks again when it is back', () => {
    inApp('android')
    mount()
    setVisibility('hidden')
    expect(plugin.stop).toHaveBeenCalledTimes(1)
    setVisibility('visible')
    expect(plugin.start).toHaveBeenCalledTimes(2)
  })

  it('says so when nothing has turned up for a while', () => {
    vi.useFakeTimers()
    inApp('android')
    mount()
    act(() => vi.advanceTimersByTime(QUIET_AFTER_MS - 1))
    expect(seen.quiet).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(seen.quiet).toBe(true)
    plugin.emit('boxes', { boxes: [service()] })
    expect(seen.quiet).toBe(false)
    // And a box that goes again leaves it quiet at once, not after another wait.
    plugin.emit('boxes', { boxes: [] })
    expect(seen.quiet).toBe(true)
  })

  it('passes on how the native side is getting on, and only what it knows of', () => {
    inApp('android')
    mount()
    plugin.emit('state', { state: 'waiting' })
    expect(seen.state).toBe('waiting')
    plugin.emit('state', { state: 'something new' })
    expect(seen.state).toBe('waiting')
    plugin.emit('state', { state: 'denied' })
    expect(seen.state).toBe('denied')
  })

  it('fails visibly when the native side will not start', async () => {
    inApp('android')
    plugin.start.mockRejectedValueOnce(new Error('no'))
    mount()
    await act(async () => {})
    expect(seen.state).toBe('failed')
  })
})

describe('the first search on an iPhone', () => {
  it('waits for a tap, because iOS asks about the local network once and only once', () => {
    inApp('ios')
    mount()
    expect(seen.state).toBe('ask')
    expect(plugin.start).not.toHaveBeenCalled()

    act(() => searchNow())
    expect(plugin.start).toHaveBeenCalledTimes(1)
    expect(seen.state).toBe('searching')
    expect(localStorage.getItem(ASKED_KEY)).toBe('1')
  })

  it('starts by itself every time after that', () => {
    localStorage.setItem(ASKED_KEY, '1')
    inApp('ios')
    mount()
    expect(plugin.start).toHaveBeenCalledTimes(1)
  })

  it('never asks while the app is out of sight, where iOS would refuse without asking', () => {
    inApp('ios')
    mount()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    act(() => searchNow())
    expect(plugin.start).not.toHaveBeenCalled()
    setVisibility('visible')
    expect(plugin.start).toHaveBeenCalledTimes(1)
  })
})
