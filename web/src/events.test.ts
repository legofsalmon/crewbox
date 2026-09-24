// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, PublicConfig, WelcomeMessage } from '@crewbox/shared'

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
    socket!.onMessage(welcome('the-spare', 'Harbour Fest'))
    await settle()
    expect(sent).toEqual([])
    expect(socket!.stopped).toBe(true)
    expect(store.getState().hasConnected).toBe(false)
    expect(store.getState().elsewhere).toEqual({ id: 'the-spare', name: 'Harbour Fest' })
  })

  it('leaves everything of the open event where it was', async () => {
    const store = await loadStore()
    await store.getState().boot()
    socket!.onMessage(welcome('the-spare'))
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
    socket!.onMessage(welcome('the-spare', 'Harbour Fest'))
    await settle()
    expect(knownEvent('friday')).toMatchObject({ replacedBy: 'the-spare', origin: location.origin })
    expect(knownEvent('the-spare')).toMatchObject({ name: 'Harbour Fest', origin: location.origin })
  })

  it('opens the event that is there when asked, and only then', async () => {
    const store = await loadStore()
    await store.getState().boot()
    socket!.onMessage(welcome('the-spare'))
    await settle()
    history.replaceState(null, '', '/m/patch/fridays-sheet')
    store.getState().switchEvent('the-spare')
    expect(localStorage.getItem('crewbox:event')).toBe('the-spare')
    expect(reload).toHaveBeenCalledTimes(1)
    // At its start, not on a sheet of the event it left.
    expect(location.pathname).toBe('/')
    // And the next page load has the spare's own, empty, storage open.
    const next = await loadStore()
    await next.getState().boot()
    expect(next.getState().phase).toBe('join')
  })

  it('is found out from the box’s config before the socket has said anything', async () => {
    api.getConfig.mockResolvedValue(config('the-spare', 'Harbour Tour'))
    const store = await loadStore()
    await store.getState().boot()
    await settle()
    expect(store.getState().elsewhere).toEqual({ id: 'the-spare', name: 'Harbour Tour' })
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
    api.getConfig.mockResolvedValue(config('the-spare'))
    const store = await loadStore()
    await store.getState().sessionEnded()
    expect(localStorage.getItem('crewbox:token')).toBe('fridays-sign-in')
    expect(reload).not.toHaveBeenCalled()
    expect(store.getState().elsewhere?.id).toBe('the-spare')
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
