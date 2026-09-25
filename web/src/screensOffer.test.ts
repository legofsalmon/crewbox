// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@crewbox/shared'
import type { ClientMessage, PublicConfig, WelcomeMessage } from '@crewbox/shared'
import { APP_VERSION } from './lib/pwa.ts'
import type { ScreensAnswer, ScreensPlugin } from './lib/server.ts'

/**
 * What the apps do when a box runs another build of crewbox than the screens
 * on the phone, and when they open another event (lib/appScreens.ts,
 * phase3-design.md, Decisions 5 and 7).
 *
 * A browser takes a box's new build from the box through its service worker.
 * The apps have none: their pill switches to the box's own screens once the
 * app has them on the phone, checked, and otherwise a note says what to
 * update. The socket, the API and the app are stood in for; the store is the
 * real one, loaded afresh per test the way a page load evaluates it.
 */

const sent: ClientMessage[] = []
let socket: { onMessage: (msg: unknown) => void; stopped: boolean } | null = null

vi.mock('./lib/ws.ts', () => ({
  WsClient: class {
    constructor(handlers: { onMessage: (msg: unknown) => void }) {
      socket = { onMessage: handlers.onMessage, stopped: false }
    }
    start() {}
    stop() {
      if (socket) socket.stopped = true
    }
    restart() {}
    send(msg: ClientMessage) {
      sent.push(msg)
    }
    reconnectNow() {}
  },
}))

const api = {
  getConfig: vi.fn<() => Promise<PublicConfig>>(),
  getConfigAt: vi.fn<(origin: string, signal?: AbortSignal) => Promise<PublicConfig>>(),
  join: vi.fn<() => Promise<{ token: string; eventId?: string }>>(),
  renewSession: vi.fn<(token: string, signal?: AbortSignal) => Promise<{ token: string }>>(),
}
vi.mock('./lib/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api.ts')>()),
  getConfig: () => api.getConfig(),
  getConfigAt: (origin: string, signal?: AbortSignal) => api.getConfigAt(origin, signal),
  join: () => api.join(),
  renewSession: (token: string, signal?: AbortSignal) => api.renewSession(token, signal),
}))

const config = (eventId: string, eventName = 'Harbour Fest'): PublicConfig => ({
  eventName,
  wifiSsid: '',
  voiceEnabled: false,
  modules: ['chat'],
  eventId,
})

/** The open event's box, saying which build it runs. */
const welcome = (
  build: { serverVersion: string; protocolVersion?: number } = { serverVersion: APP_VERSION }
): WelcomeMessage => ({
  type: 'welcome',
  ...build,
  config: config('friday'),
  me: { id: 'u1', name: 'Sam', role: 'member' } as WelcomeMessage['me'],
  users: [],
  channels: [],
  readState: {},
  online: [],
  missed: [],
  truncated: [],
  deletions: [],
  dbEpoch: 'friday',
})

/** A build of crewbox these screens aren't. */
const OTHER = '9.8.7+abc1234'
const NEWER = { serverVersion: OTHER, protocolVersion: PROTOCOL_VERSION }

const BOX = 'http://10.0.0.2'

let reload: ReturnType<typeof vi.fn<() => void>>
/** What happened, in order: the app's switches and the page's reloads. */
let happened: string[]

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The Android app, signed in at Friday's box, with its screens plugin stood in for. */
function inTheApp() {
  const screens = {
    prepare: vi.fn<ScreensPlugin['prepare']>(async () => ({ result: 'unsigned' })),
    use: vi.fn<ScreensPlugin['use']>(async ({ event, version }) => {
      happened.push(`use ${event}${version ? ` ${version}` : ''}`)
    }),
    ready: vi.fn<ScreensPlugin['ready']>(async () => {}),
  }
  ;(window as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: {
      CrewboxScreens: screens,
      CrewboxAlerts: { start: async () => {}, stop: async () => {} },
    },
  }
  localStorage.setItem('crewbox:server-url', BOX)
  return screens
}

/** A page load, signed in and welcomed by its box, which runs `build`. */
async function welcomed(build?: { serverVersion: string; protocolVersion?: number }) {
  vi.resetModules()
  const store = (await import('./store.ts')).useStore
  await store.getState().boot()
  socket!.onMessage(welcome(build))
  await settle()
  await settle()
  return store
}

/** Another event this phone holds, at another box. */
async function holdSaturday() {
  const { rememberEvent } = await import('./lib/eventScope.ts')
  rememberEvent({ id: 'saturday', name: 'Harbour Tour', origin: 'http://10.0.0.3:8787', seenAt: 2 })
}

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/')
  sent.length = 0
  socket = null
  happened = []
  api.getConfig.mockReset()
  api.getConfigAt.mockReset()
  api.join.mockReset()
  api.renewSession.mockReset()
  api.renewSession.mockRejectedValue(new TypeError('Failed to fetch'))
  api.getConfig.mockReturnValue(new Promise(() => {}))
  api.getConfigAt.mockRejectedValue(new TypeError('Failed to fetch'))
  reload = vi.fn<() => void>(() => happened.push('reload'))
  vi.spyOn(window.location, 'reload').mockImplementation(reload)
  localStorage.setItem('crewbox:db-epoch', 'friday')
  localStorage.setItem('crewbox:token', 'fridays-sign-in')
  localStorage.setItem('crewbox:event-name', 'Harbour Fest')
})

afterEach(() => {
  delete (window as { Capacitor?: unknown }).Capacitor
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('in the apps, a welcome from a box running another build', () => {
  it('has the app fetch its screens, and offers them once they are on the phone', async () => {
    const screens = inTheApp()
    let answer: (value: ScreensAnswer) => void = () => {}
    screens.prepare.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const store = await welcomed(NEWER)
    expect(screens.prepare).toHaveBeenCalledWith({ origin: BOX })
    // Nothing while the app fetches them.
    expect(store.getState().updateReady).toBe(false)
    answer({ result: 'ready', version: OTHER })
    await settle()
    expect(store.getState().updateReady).toBe(true)
    expect(store.getState().screensNote).toBeNull()
  })

  it('switches to them for the open event on a tap, and only then reloads', async () => {
    const screens = inTheApp()
    screens.prepare.mockResolvedValue({ result: 'ready', version: OTHER })
    const store = await welcomed(NEWER)
    history.replaceState(null, '', '/m/patch/fridays-sheet')
    store.getState().applyUpdate()
    // The app hasn't switched yet: nothing reloads.
    expect(reload).not.toHaveBeenCalled()
    await settle()
    expect(screens.use).toHaveBeenCalledWith({ event: 'friday', version: OTHER })
    expect(happened).toEqual([`use friday ${OTHER}`, 'reload'])
    expect(socket!.stopped).toBe(true)
    // Where it was, which a reload keeps.
    expect(location.pathname).toBe('/m/patch/fridays-sheet')
  })

  it('switches once, however often it is tapped', async () => {
    const screens = inTheApp()
    screens.prepare.mockResolvedValue({ result: 'ready', version: OTHER })
    const store = await welcomed(NEWER)
    store.getState().applyUpdate()
    store.getState().applyUpdate()
    await settle()
    expect(screens.use).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('says so, and carries on, when the app won’t switch to them after all', async () => {
    const screens = inTheApp()
    screens.prepare.mockResolvedValue({ result: 'ready', version: OTHER })
    screens.use.mockRejectedValue(new Error(`${OTHER} didn't start on this phone`))
    const store = await welcomed(NEWER)
    store.getState().applyUpdate()
    await settle()
    expect(reload).not.toHaveBeenCalled()
    expect(store.getState().updateReady).toBe(false)
    expect(store.getState().toasts.map((toast) => toast.message)).toEqual([
      'This phone couldn’t open the new version, so it carries on with this one.',
    ])
    expect(socket!.stopped).toBe(false)
  })

  it('offers nothing while the box runs these screens’ build, and takes an offer back when it does again', async () => {
    const screens = inTheApp()
    const store = await welcomed()
    expect(screens.prepare).not.toHaveBeenCalled()
    expect(store.getState().updateReady).toBe(false)

    screens.prepare.mockResolvedValue({ result: 'ready', version: OTHER })
    socket!.onMessage(welcome(NEWER))
    await settle()
    await settle()
    expect(store.getState().updateReady).toBe(true)
    // The box went back to these screens' build.
    socket!.onMessage(welcome())
    await settle()
    expect(store.getState().updateReady).toBe(false)
    store.getState().applyUpdate()
    await settle()
    expect(screens.use).not.toHaveBeenCalled()
  })

  it('offers nothing that would reload what runs now', async () => {
    const screens = inTheApp()
    screens.prepare.mockResolvedValue({ result: 'same', version: APP_VERSION })
    const store = await welcomed(NEWER)
    expect(store.getState().updateReady).toBe(false)
    expect(store.getState().screensNote).toBeNull()
  })

  it('says what to update when the app can’t run the box’s screens, and stays quiet once told', async () => {
    const screens = inTheApp()
    screens.prepare.mockResolvedValue({ result: 'incompatible', version: OTHER, update: 'app' })
    const store = await welcomed(NEWER)
    expect(store.getState().updateReady).toBe(false)
    expect(store.getState().screensNote).toBe(
      'This box runs crewbox 9.8.7, whose screens need a newer app. Update the app to use them.'
    )
    store.getState().dismissScreensNote()
    expect(store.getState().screensNote).toBeNull()
    // Put away for this load: a reconnect doesn't bring it back.
    socket!.onMessage(welcome(NEWER))
    await settle()
    await settle()
    expect(store.getState().screensNote).toBeNull()
    // Something new to say is said.
    screens.prepare.mockResolvedValue({ result: 'unsigned' })
    socket!.onMessage(welcome({ serverVersion: OTHER, protocolVersion: PROTOCOL_VERSION + 1 }))
    await settle()
    await settle()
    expect(store.getState().screensNote).toMatch(/^This box runs crewbox 9\.8\.7, newer than/)
  })

  it('never raises a pill for another protocol that can only reload what runs now', async () => {
    // What a welcome with another protocol raised before: a reload of the
    // app's own screens, and the same pill again at the next welcome.
    const screens = inTheApp()
    let answer: (value: ScreensAnswer) => void = () => {}
    screens.prepare.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const store = await welcomed({ serverVersion: OTHER, protocolVersion: PROTOCOL_VERSION + 1 })
    // Not while the app fetches the box's screens,
    expect(store.getState().updateReady).toBe(false)
    answer({ result: 'failed', reason: 'no signal' })
    await settle()
    // nor once it couldn't.
    expect(store.getState().updateReady).toBe(false)
    expect(store.getState().screensNote).toBe(
      'This box runs crewbox 9.8.7, newer than this app can use, and the app couldn’t get its ' +
        'screens to run instead. Update the app.'
    )
  })
})

describe('in a browser, a welcome from a box running another build', () => {
  it('asks no app for screens, and leaves the pill to the service worker', async () => {
    const store = await welcomed(NEWER)
    // No service worker controls this page, so no pill (store.ts).
    expect(store.getState().updateReady).toBe(false)
    expect(store.getState().screensNote).toBeNull()
    socket!.onMessage(welcome({ serverVersion: OTHER, protocolVersion: PROTOCOL_VERSION + 1 }))
    await settle()
    // Another protocol raises it, as it always has.
    expect(store.getState().updateReady).toBe(true)
    expect(store.getState().screensNote).toBeNull()
  })
})

describe('in the apps, opening another event', () => {
  it('has the app serve its box’s screens first, and changes nothing of this page’s until then', async () => {
    const screens = inTheApp()
    const store = await welcomed()
    await holdSaturday()
    api.getConfigAt.mockResolvedValue(config('saturday', 'Harbour Tour'))
    screens.prepare.mockResolvedValue({ result: 'ready', version: OTHER })
    let switched: () => void = () => {}
    screens.use.mockImplementation(({ event, version }) => {
      happened.push(`use ${event} ${version}`)
      return new Promise((resolve) => (switched = () => resolve()))
    })

    store.getState().switchEvent('saturday')
    expect(store.getState().toasts.map((toast) => toast.message)).toEqual(['Opening Harbour Tour…'])
    await settle()
    await settle()
    expect(api.getConfigAt).toHaveBeenCalledWith('http://10.0.0.3:8787', expect.any(AbortSignal))
    expect(screens.prepare).toHaveBeenCalledWith({ origin: 'http://10.0.0.3:8787' })
    expect(happened).toEqual([`use saturday ${OTHER}`])
    // Still Friday's page until the app serves Saturday's screens.
    expect(localStorage.getItem('crewbox:server-url')).toBe(BOX)
    const { openEvent } = await import('./lib/eventScope.ts')
    expect(openEvent()).toBe('friday')

    switched()
    await settle()
    expect(happened).toEqual([`use saturday ${OTHER}`, 'reload'])
    expect(localStorage.getItem('crewbox:server-url')).toBe('http://10.0.0.3:8787')
    expect(localStorage.getItem('crewbox:event')).toBe('saturday')
  })

  it('opens it on what it would start with when its box doesn’t answer', async () => {
    inTheApp()
    const store = await welcomed()
    await holdSaturday()
    store.getState().switchEvent('saturday')
    await settle()
    await settle()
    expect(happened).toEqual(['use saturday', 'reload'])
  })

  it('opens it once, however often it is asked', async () => {
    const screens = inTheApp()
    const store = await welcomed()
    await holdSaturday()
    store.getState().switchEvent('saturday')
    store.getState().switchEvent('saturday')
    await settle()
    await settle()
    expect(screens.use).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('offers nothing of the box it is leaving meanwhile', async () => {
    const screens = inTheApp()
    const store = await welcomed()
    await holdSaturday()
    // Saturday's box is slow to answer.
    api.getConfigAt.mockReturnValue(new Promise(() => {}))
    store.getState().switchEvent('saturday')
    // Friday's box, back meanwhile with another build.
    screens.prepare.mockResolvedValue({ result: 'ready', version: OTHER })
    socket!.onMessage(welcome(NEWER))
    await settle()
    await settle()
    expect(screens.prepare).toHaveBeenCalledWith({ origin: BOX })
    expect(store.getState().updateReady).toBe(false)
  })

  it('stays as it was in a browser, which reloads at once', async () => {
    const store = await welcomed()
    await holdSaturday()
    store.getState().switchEvent('saturday')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(api.getConfigAt).not.toHaveBeenCalled()
  })
})

describe('in the apps, joining a box running another event', () => {
  it('has the app serve its screens before the reload into it', async () => {
    localStorage.removeItem('crewbox:token')
    const screens = inTheApp()
    api.join.mockResolvedValue({ token: 'saturdays-sign-in', eventId: 'saturday' })
    api.getConfigAt.mockResolvedValue(config('saturday', 'Harbour Tour'))
    screens.prepare.mockResolvedValue({ result: 'ready', version: OTHER })
    vi.resetModules()
    const store = (await import('./store.ts')).useStore
    await store.getState().join('Sam', '4242', '1234')
    expect(api.getConfigAt).toHaveBeenCalledWith(BOX, expect.any(AbortSignal))
    expect(happened).toEqual([`use saturday ${OTHER}`, 'reload'])
    expect(localStorage.getItem('crewbox:event')).toBe('saturday')
  })
})
