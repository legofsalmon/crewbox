// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, PublicConfig, WelcomeMessage } from '@crewbox/shared'
import type { QueuedIncident } from './modules/incident/model/outbox.ts'

/**
 * A phone at an address where the box is running another event.
 *
 * A spare box with a fresh database put where the event's box was, or the
 * next event's box on the same address. The phone used to carry on: it
 * dropped its cached chat, flushed its queued messages and show-log entries
 * into the new database, and synced its sheets and running order into the
 * new box. Now it sends that box nothing of the old event's, keeps all of it,
 * and offers to open the event that is there.
 *
 * The socket and the API are stood in for; the store is the real one, loaded
 * afresh per test the way a page load evaluates it.
 */

const sent: ClientMessage[] = []
let socket: { onMessage: (msg: unknown) => void; stopped: boolean } | null = null

vi.mock('./lib/ws.ts', () => ({
  WsClient: class {
    handlers: { onMessage: (msg: unknown) => void }
    constructor(handlers: { onMessage: (msg: unknown) => void }) {
      this.handlers = handlers
      socket = { onMessage: handlers.onMessage, stopped: false }
    }
    start() {}
    stop() {
      if (socket) socket.stopped = true
    }
    send(msg: ClientMessage) {
      sent.push(msg)
    }
    reconnectNow() {}
  },
}))

const api = {
  getConfig: vi.fn<() => Promise<PublicConfig>>(),
  join: vi.fn<() => Promise<{ token: string; eventId?: string }>>(),
}
vi.mock('./lib/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api.ts')>()),
  getConfig: () => api.getConfig(),
  join: () => api.join(),
}))

const config = (eventId: string, eventName = 'Harbour Fest'): PublicConfig => ({
  eventName,
  wifiSsid: '',
  voiceEnabled: false,
  modules: ['chat', 'incident'],
  eventId,
})

const welcome = (eventId: string, eventName?: string): WelcomeMessage => ({
  type: 'welcome',
  serverVersion: 'test',
  config: config(eventId, eventName),
  me: { id: 'u1', name: 'Sam', role: 'member' } as WelcomeMessage['me'],
  users: [],
  channels: [],
  readState: {},
  online: [],
  missed: [],
  truncated: [],
  deletions: [],
  dbEpoch: eventId,
})

/** A show-log entry typed with no signal, waiting for the box. */
const QUEUED = {
  clientMsgId: 'queued-at-friday',
  kind: 'note',
  severity: 'info',
  body: 'Barrier moved at stage left',
  at: 1,
  stage: 'Main',
  actId: '',
  actName: '',
}

let reload: ReturnType<typeof vi.fn<() => void>>

async function loadStore() {
  vi.resetModules()
  return (await import('./store.ts')).useStore
}

/** Let a promise chain run: the welcome handler awaits the cache. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/')
  sent.length = 0
  socket = null
  api.getConfig.mockReset()
  api.join.mockReset()
  // Never answers unless a test says so: the socket is what speaks first.
  api.getConfig.mockReturnValue(new Promise(() => {}))
  reload = vi.fn<() => void>()
  vi.spyOn(window.location, 'reload').mockImplementation(reload)
  // A phone signed in at Friday's box, as every phone in the field is.
  localStorage.setItem('crewbox:db-epoch', 'friday')
  localStorage.setItem('crewbox:token', 'fridays-sign-in')
  localStorage.setItem('crewbox:event-name', 'Harbour Fest')
  localStorage.setItem('crewbox:incident-outbox', JSON.stringify([QUEUED]))
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('a welcome from the box running the event this phone has open', () => {
  it('is taken, and what was queued goes out', async () => {
    const store = await loadStore()
    await store.getState().boot()
    socket!.onMessage(welcome('friday'))
    await settle()
    expect(store.getState().hasConnected).toBe(true)
    expect(store.getState().elsewhere).toBeNull()
    expect(sent.map((m) => m.type)).toContain('logIncident')
  })
})

describe('a welcome from a box running another event', () => {
  it('is refused before anything queued is sent to it', async () => {
    const store = await loadStore()
    await store.getState().boot()
    socket!.onMessage(welcome('spare', 'Harbour Fest'))
    await settle()
    expect(sent).toEqual([])
    expect(socket!.stopped).toBe(true)
    expect(store.getState().hasConnected).toBe(false)
    expect(store.getState().elsewhere).toEqual({ id: 'spare', name: 'Harbour Fest' })
  })

  it('leaves everything of the open event where it was', async () => {
    const store = await loadStore()
    await store.getState().boot()
    socket!.onMessage(welcome('spare'))
    await settle()
    expect(localStorage.getItem('crewbox:token')).toBe('fridays-sign-in')
    expect(localStorage.getItem('crewbox:db-epoch')).toBe('friday')
    expect(JSON.parse(localStorage.getItem('crewbox:incident-outbox')!)).toEqual([QUEUED])
    expect(reload).not.toHaveBeenCalled()
  })

  it('records that the event now at this address took the open one’s place', async () => {
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await store.getState().boot()
    socket!.onMessage(welcome('spare', 'Harbour Fest'))
    await settle()
    expect(knownEvent('friday')).toMatchObject({ replacedBy: 'spare', origin: location.origin })
    expect(knownEvent('spare')).toMatchObject({ name: 'Harbour Fest', origin: location.origin })
  })

  it('opens the event that is there when asked, and only then', async () => {
    const store = await loadStore()
    await store.getState().boot()
    socket!.onMessage(welcome('spare'))
    await settle()
    history.replaceState(null, '', '/m/patch/fridays-sheet')
    store.getState().switchEvent('spare')
    expect(localStorage.getItem('crewbox:event')).toBe('spare')
    expect(reload).toHaveBeenCalledTimes(1)
    // At its start, not on a sheet of the event it left.
    expect(location.pathname).toBe('/')
    // And the next page load has the spare's own, empty, storage open.
    const next = await loadStore()
    await next.getState().boot()
    expect(next.getState().phase).toBe('join')
  })

  it('is found out from the box’s config before the socket has said anything', async () => {
    api.getConfig.mockResolvedValue(config('spare', 'Harbour Tour'))
    const store = await loadStore()
    await store.getState().boot()
    await settle()
    expect(store.getState().elsewhere).toEqual({ id: 'spare', name: 'Harbour Tour' })
    // No socket left running: stopped, or here, never started.
    expect(socket?.stopped ?? true).toBe(true)
    expect(sent).toEqual([])
    // Its name is the new box's, and is not cached as this event's.
    expect(localStorage.getItem('crewbox:event-name')).toBe('Harbour Fest')
  })
})

describe('a box refusing this phone’s session', () => {
  it('ends the session when it is the same event', async () => {
    api.getConfig.mockResolvedValue(config('friday'))
    const store = await loadStore()
    await store.getState().sessionEnded()
    expect(localStorage.getItem('crewbox:token')).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the sign-in when the box is another event, which never issued it', async () => {
    // A spare with a fresh database refuses every session: this one is the
    // old event's, and is still good for the old event's box.
    api.getConfig.mockResolvedValue(config('spare'))
    const store = await loadStore()
    await store.getState().sessionEnded()
    expect(localStorage.getItem('crewbox:token')).toBe('fridays-sign-in')
    expect(reload).not.toHaveBeenCalled()
    expect(store.getState().elsewhere?.id).toBe('spare')
  })
})

describe('work brought across from the event this box replaced', () => {
  it('is queued here as if written here, and sent', async () => {
    localStorage.setItem('crewbox:incident-outbox', '[]')
    const store = await loadStore()
    await store.getState().boot()
    socket!.onMessage(welcome('friday'))
    await settle()
    sent.length = 0
    const saved = await store
      .getState()
      .queueMoved([], [{ ...QUEUED, clientMsgId: 'from-the-old-box' } as QueuedIncident])
    expect(saved).toEqual(new Set(['from-the-old-box']))
    expect(JSON.parse(localStorage.getItem('crewbox:incident-outbox') ?? '[]')).toMatchObject([
      { clientMsgId: 'from-the-old-box', body: QUEUED.body },
    ])
    await settle()
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'logIncident', clientMsgId: 'from-the-old-box' })
    )
  })

  it('claims only what it saved, so the other event keeps the rest', async () => {
    // A chat outbox that could not take the message, which the cache does not
    // say: the other event's copy is all there is, and must not be let go of.
    const store = await loadStore()
    const { cache } = await import('./lib/db.ts')
    vi.spyOn(cache, 'putOutbox').mockResolvedValue()
    vi.spyOn(cache, 'loadOutbox').mockResolvedValue([])
    await store.getState().boot()
    const saved = await store
      .getState()
      .queueMoved(
        [{ clientMsgId: 'unsent', channelId: 'general-here', body: 'Doors in ten', createdAt: 1 }],
        []
      )
    expect(saved.has('unsent')).toBe(false)
    expect(store.getState().pending['general-here']).toBeUndefined()
  })
})

describe('joining', () => {
  it('files the sign-in under the event the box is running, and opens it', async () => {
    // Signed out of Friday, joining whatever is at the address now.
    localStorage.removeItem('crewbox:token')
    api.join.mockResolvedValue({ token: 'saturdays-sign-in', eventId: 'saturday' })
    history.replaceState(null, '', '/c/fridays-channel')
    const store = await loadStore()
    await store.getState().join('Sam', '4242', '1234')
    expect(localStorage.getItem('crewbox@saturday:token')).toBe('saturdays-sign-in')
    expect(localStorage.getItem('crewbox:token')).toBeNull()
    expect(localStorage.getItem('crewbox:event')).toBe('saturday')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(location.pathname).toBe('/')
  })

  it('signs back in to the open event where it always did', async () => {
    localStorage.removeItem('crewbox:token')
    api.join.mockResolvedValue({ token: 'fridays-new-sign-in', eventId: 'friday' })
    const store = await loadStore()
    await store.getState().join('Sam', '4242', '1234')
    expect(localStorage.getItem('crewbox:token')).toBe('fridays-new-sign-in')
    expect(localStorage.getItem('crewbox:event')).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it('gives a new phone’s first event today’s names', async () => {
    localStorage.clear()
    api.join.mockResolvedValue({ token: 'first-sign-in', eventId: 'friday' })
    const store = await loadStore()
    await store.getState().join('Sam', '4242', '1234')
    expect(localStorage.getItem('crewbox:token')).toBe('first-sign-in')
    expect(localStorage.getItem('crewbox:db-epoch')).toBe('friday')
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('a box at an address typed into the Boxes screen', () => {
  /** The app, which reaches its box at an address of its own. */
  function inTheApp(at: string) {
    ;(window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
    }
    localStorage.setItem('crewbox:server-url', at)
    localStorage.setItem(
      'crewbox:boxes',
      JSON.stringify([{ id: 'friday', name: 'Harbour Fest', origin: at, seenAt: 1 }])
    )
  }

  afterEach(() => {
    delete (window as { Capacitor?: unknown }).Capacitor
  })

  it('follows the open event’s own box to where it is now, keeping everything', async () => {
    inTheApp('http://10.0.0.2')
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    store.getState().openEventAt({ id: 'friday', name: 'Harbour Fest', origin: 'http://10.0.0.9' })
    expect(localStorage.getItem('crewbox:server-url')).toBe('http://10.0.0.9')
    expect(knownEvent('friday')?.origin).toBe('http://10.0.0.9')
    expect(localStorage.getItem('crewbox:token')).toBe('fridays-sign-in')
    expect(localStorage.getItem('crewbox:event')).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('opens another event this device holds, at the address typed', async () => {
    inTheApp('http://10.0.0.2')
    const store = await loadStore()
    const { rememberEvent } = await import('./lib/eventScope.ts')
    rememberEvent({ id: 'saturday', name: 'Harbour Tour', origin: 'http://10.0.0.3', seenAt: 2 })
    history.replaceState(null, '', '/m/patch/fridays-sheet')
    store
      .getState()
      .openEventAt({ id: 'saturday', name: 'Harbour Tour', origin: 'http://10.0.0.9' })
    expect(localStorage.getItem('crewbox:event')).toBe('saturday')
    expect(localStorage.getItem('crewbox:server-url')).toBe('http://10.0.0.9')
    expect(location.pathname).toBe('/')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('files a new event under its own ID and asks to join it', async () => {
    inTheApp('http://10.0.0.2')
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    store.getState().openEventAt({ id: 'sunday', name: 'Quay Sessions', origin: 'http://10.0.0.9' })
    expect(knownEvent('sunday')).toMatchObject({ name: 'Quay Sessions', origin: 'http://10.0.0.9' })
    expect(localStorage.getItem('crewbox:event')).toBe('sunday')
    const next = await loadStore()
    await next.getState().boot()
    expect(next.getState().phase).toBe('join')
    // Friday's sign-in is still Friday's.
    expect(localStorage.getItem('crewbox:token')).toBe('fridays-sign-in')
  })

  it('gives a new phone’s first event today’s names, as joining does', async () => {
    localStorage.clear()
    inTheApp('http://10.0.0.2')
    localStorage.removeItem('crewbox:boxes')
    const store = await loadStore()
    store.getState().openEventAt({ id: 'friday', name: 'Harbour Fest', origin: 'http://10.0.0.9' })
    expect(localStorage.getItem('crewbox:db-epoch')).toBe('friday')
    expect(localStorage.getItem('crewbox:server-url')).toBe('http://10.0.0.9')
    expect(reload).toHaveBeenCalledTimes(1)
    const { storageName } = await import('./lib/eventScope.ts')
    expect(storageName('crewbox:token')).toBe('crewbox:token')
  })

  it('tries again, and goes nowhere, when it is the box this app already uses', async () => {
    inTheApp('http://10.0.0.2')
    const store = await loadStore()
    await store.getState().boot()
    store.getState().setBoxesOpen(true)
    store.getState().openEventAt({ id: 'friday', name: 'Harbour Fest', origin: 'http://10.0.0.2' })
    expect(reload).not.toHaveBeenCalled()
    expect(store.getState().boxesOpen).toBe(false)
    expect(store.getState().connection).toBe('connecting')
  })
})
