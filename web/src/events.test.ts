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
let socket: { onMessage: (msg: unknown) => void; stopped: boolean; restarts: number } | null = null

vi.mock('./lib/ws.ts', () => ({
  WsClient: class {
    handlers: { onMessage: (msg: unknown) => void }
    constructor(handlers: { onMessage: (msg: unknown) => void }) {
      this.handlers = handlers
      socket = { onMessage: handlers.onMessage, stopped: false, restarts: 0 }
    }
    start() {}
    stop() {
      if (socket) socket.stopped = true
    }
    /** To wherever the page reaches its box now, as the real one does. */
    restart() {
      if (!socket) return
      socket.stopped = false
      socket.restarts++
    }
    send(msg: ClientMessage) {
      sent.push(msg)
    }
    reconnectNow() {}
  },
}))

const api = {
  getConfig: vi.fn<() => Promise<PublicConfig>>(),
  join: vi.fn<() => Promise<{ token: string; eventId?: string; eventKey?: string }>>(),
}
vi.mock('./lib/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api.ts')>()),
  getConfig: () => api.getConfig(),
  join: () => api.join(),
}))

const config = (eventId: string, eventName = 'Harbour Fest', eventKey?: string): PublicConfig => ({
  eventName,
  wifiSsid: '',
  voiceEnabled: false,
  modules: ['chat', 'incident'],
  eventId,
  ...(eventKey ? { eventKey } : {}),
})

const welcome = (eventId: string, eventName?: string, eventKey?: string): WelcomeMessage => ({
  type: 'welcome',
  serverVersion: 'test',
  config: config(eventId, eventName, eventKey),
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

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

/**
 * A box with a signing key of its own, answering /api/identity for `eventId`
 * as server/src/app.ts does: for the address it was asked at.
 */
async function aBox(eventId: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const key = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  const answer = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input))
    const statement = `crewbox-identity-v1\n${eventId}\n${url.host}\n${url.searchParams.get('nonce')}`
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(statement)
    )
    return new Response(
      JSON.stringify({ eventId, key, signature: base64url(new Uint8Array(signature)) }),
      { headers: { 'content-type': 'application/json' } }
    )
  }
  return { key, answer }
}

/** Whatever answers a phone's check, and every address it was asked at. */
function answering(answer: (input: RequestInfo | URL) => Promise<Response> | Response) {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input))
      return answer(input)
    })
  )
  return asked
}

/** An event this phone holds at another box's address, with the key kept for it or none. */
async function holdSaturday(key?: string) {
  const { rememberEvent } = await import('./lib/eventScope.ts')
  rememberEvent({
    id: 'saturday',
    name: 'Harbour Tour',
    origin: 'http://10.0.0.3:8787',
    seenAt: 2,
    ...(key ? { key } : {}),
  })
}

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

describe('a box at this address saying it runs an event this phone holds elsewhere', () => {
  // Anything that took this address can say which event it runs. The event
  // moves here only once the box has signed for this address with the key
  // kept for it (lib/identity.ts), and until then nothing of either event's
  // records changes.
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('moves it here once the box has signed for this address with the key kept', async () => {
    const saturday = await aBox('saturday')
    const asked = answering(saturday.answer)
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await holdSaturday(saturday.key)
    await store.getState().boot()
    socket!.onMessage(welcome('saturday', 'Harbour Tour'))
    await settle()
    expect(sent).toEqual([])
    await vi.waitFor(() =>
      expect(store.getState().elsewhere).toEqual({
        id: 'saturday',
        name: 'Harbour Tour',
        held: { origin: 'http://10.0.0.3:8787', proof: 'proven' },
      })
    )
    expect(asked).toEqual([expect.stringMatching(`^${location.origin}/api/identity\\?nonce=`)])
    expect(knownEvent('saturday')).toMatchObject({ origin: location.origin, key: saturday.key })
    expect(knownEvent('friday')).toMatchObject({ replacedBy: 'saturday' })
  })

  it('moves nothing when the box signs with another key', async () => {
    const saturday = await aBox('saturday')
    const impostor = await aBox('saturday')
    answering(impostor.answer)
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await holdSaturday(saturday.key)
    await store.getState().boot()
    socket!.onMessage(welcome('saturday', 'Harbour Tour'))
    await vi.waitFor(() => expect(store.getState().elsewhere?.held?.proof).toBe('refused'))
    expect(knownEvent('saturday')).toMatchObject({
      origin: 'http://10.0.0.3:8787',
      key: saturday.key,
    })
    expect(knownEvent('friday')?.replacedBy).toBeUndefined()
    expect(sent).toEqual([])
  })

  it('moves nothing, and asks nothing, when no key was kept for it', async () => {
    const asked = answering(() => new Response('{}', { status: 500 }))
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await holdSaturday()
    await store.getState().boot()
    socket!.onMessage(welcome('saturday', 'Harbour Tour'))
    await settle()
    expect(store.getState().elsewhere).toEqual({
      id: 'saturday',
      name: 'Harbour Tour',
      held: { origin: 'http://10.0.0.3:8787', proof: 'unchecked' },
    })
    expect(asked).toEqual([])
    expect(knownEvent('saturday')?.origin).toBe('http://10.0.0.3:8787')
    expect(knownEvent('friday')?.replacedBy).toBeUndefined()
  })
})

describe('the key kept for an event', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is taken from its box’s welcome when none was kept, and never swapped for another', async () => {
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    const first = await aBox('friday')
    const second = await aBox('friday')
    await store.getState().boot()
    socket!.onMessage(welcome('friday', 'Harbour Fest', first.key))
    await settle()
    expect(knownEvent('friday')?.key).toBe(first.key)
    socket!.onMessage(welcome('friday', 'Harbour Fest', second.key))
    await settle()
    expect(knownEvent('friday')?.key).toBe(first.key)
  })

  it('is taken from a first sign-in', async () => {
    localStorage.clear()
    const friday = await aBox('friday')
    api.join.mockResolvedValue({ token: 'first', eventId: 'friday', eventKey: friday.key })
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await store.getState().join('Sam', '4242', '1234')
    expect(knownEvent('friday')?.key).toBe(friday.key)
  })

  it('is replaced only when somebody opens a box that failed the check anyway', async () => {
    const store = await loadStore()
    const { knownEvent, rememberEvent } = await import('./lib/eventScope.ts')
    const kept = await aBox('saturday')
    const offered = await aBox('saturday')
    rememberEvent({
      id: 'saturday',
      name: 'Harbour Tour',
      origin: 'http://10.0.0.3',
      seenAt: 2,
      key: kept.key,
    })
    const at = { id: 'saturday', name: 'Harbour Tour', origin: 'http://10.0.0.9' }
    store.getState().openEventAt(at)
    expect(knownEvent('saturday')?.key).toBe(kept.key)
    store.getState().openEventAt({ ...at, key: offered.key })
    expect(knownEvent('saturday')?.key).toBe(offered.key)
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

  it('sends no PIN to a box that says it runs an event held elsewhere and fails the check', async () => {
    localStorage.removeItem('crewbox:token')
    const saturday = await aBox('saturday')
    const impostor = await aBox('saturday')
    answering(impostor.answer)
    api.getConfig.mockResolvedValue(config('saturday', 'Harbour Tour'))
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await holdSaturday(saturday.key)
    await expect(store.getState().join('Sam', '4242', '1234')).rejects.toThrow(
      /says it is running “Harbour Tour”, but it can’t show that it is that event’s box/
    )
    expect(api.join).not.toHaveBeenCalled()
    expect(knownEvent('saturday')?.origin).toBe('http://10.0.0.3:8787')
    expect(localStorage.getItem('crewbox@saturday:token')).toBeNull()
    vi.unstubAllGlobals()
  })

  it('refuses a sign-in naming an event held elsewhere that its box can’t show it runs', async () => {
    // The box's config could not be read before the PIN went, or said
    // something else: what the sign-in says is checked all the same.
    localStorage.removeItem('crewbox:token')
    const saturday = await aBox('saturday')
    const impostor = await aBox('saturday')
    answering(impostor.answer)
    api.getConfig.mockRejectedValue(new TypeError('Failed to fetch'))
    api.join.mockResolvedValue({ token: 'not-saturdays', eventId: 'saturday' })
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await holdSaturday(saturday.key)
    await expect(store.getState().join('Sam', '4242', '1234')).rejects.toThrow(
      /can’t show that it is that event’s box/
    )
    expect(knownEvent('saturday')).toMatchObject({
      origin: 'http://10.0.0.3:8787',
      key: saturday.key,
    })
    expect(localStorage.getItem('crewbox@saturday:token')).toBeNull()
    vi.unstubAllGlobals()
  })

  it('joins a box that can’t be checked, since its address was typed', async () => {
    localStorage.removeItem('crewbox:token')
    const saturday = await aBox('saturday')
    // A box behind a port forward: it won't sign for the address asked at.
    answering(() => new Response('{}', { status: 421 }))
    api.getConfig.mockResolvedValue(config('saturday', 'Harbour Tour'))
    api.join.mockResolvedValue({ token: 'saturdays-sign-in', eventId: 'saturday' })
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await holdSaturday(saturday.key)
    await store.getState().join('Sam', '4242', '1234')
    expect(api.join).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('crewbox@saturday:token')).toBe('saturdays-sign-in')
    expect(knownEvent('saturday')).toMatchObject({ origin: location.origin, key: saturday.key })
    vi.unstubAllGlobals()
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

  it('follows the open event’s own box to where it is now, in place, keeping everything', async () => {
    inTheApp('http://10.0.0.2')
    const store = await loadStore()
    const { knownEvent, rememberEvent } = await import('./lib/eventScope.ts')
    await store.getState().boot()
    socket!.onMessage(welcome('friday'))
    await settle()
    // Something at the old address had seemed to take its place.
    rememberEvent({ id: 'friday', replacedBy: 'spare' })
    store.getState().setBoxesOpen(true)

    store.getState().openEventAt({ id: 'friday', name: 'Harbour Fest', origin: 'http://10.0.0.9' })
    expect(localStorage.getItem('crewbox:server-url')).toBe('http://10.0.0.9')
    expect(knownEvent('friday')).toMatchObject({ origin: 'http://10.0.0.9' })
    // It did not: the event is where its box is.
    expect(knownEvent('friday')?.replacedBy).toBeUndefined()
    expect(localStorage.getItem('crewbox:token')).toBe('fridays-sign-in')
    expect(localStorage.getItem('crewbox:event')).toBeNull()
    // Not a reload, which would lose whatever was in hand: the socket goes
    // to the new address, and the documents wait for its welcome.
    expect(reload).not.toHaveBeenCalled()
    expect(socket!.restarts).toBe(1)
    expect(store.getState()).toMatchObject({
      connection: 'connecting',
      boxesOpen: false,
      welcomedAt: 'http://10.0.0.2',
    })
    // Asked for, so nothing is said about it.
    expect(store.getState().toasts).toEqual([])

    socket!.onMessage(welcome('friday'))
    await settle()
    expect(store.getState()).toMatchObject({
      connection: 'online',
      welcomedAt: 'http://10.0.0.9',
    })
  })

  it('at the join form, starts again at the address its box is at now', async () => {
    inTheApp('http://10.0.0.2')
    localStorage.removeItem('crewbox:token')
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await store.getState().boot()
    expect(store.getState().phase).toBe('join')
    store.getState().openEventAt({ id: 'friday', name: 'Harbour Fest', origin: 'http://10.0.0.9' })
    expect(localStorage.getItem('crewbox:server-url')).toBe('http://10.0.0.9')
    expect(knownEvent('friday')?.origin).toBe('http://10.0.0.9')
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

  it('carries the event PIN from a crewbox://join link to the new event’s join form', async () => {
    inTheApp('http://10.0.0.2')
    const store = await loadStore()
    history.replaceState(null, '', '/m/patch/fridays-sheet')
    store
      .getState()
      .openEventAt({ id: 'sunday', name: 'Quay Sessions', origin: 'http://10.0.0.9', pin: '48 21' })
    expect(localStorage.getItem('crewbox:event')).toBe('sunday')
    expect(reload).toHaveBeenCalledTimes(1)
    // Where the poster's QR puts it, which is where the join form reads it.
    expect(location.pathname).toBe('/')
    expect(new URLSearchParams(location.search).get('pin')).toBe('48 21')
  })

  it('carries it to the join form of the open event’s box at its new address too', async () => {
    inTheApp('http://10.0.0.2')
    localStorage.removeItem('crewbox:token')
    const store = await loadStore()
    await store.getState().boot()
    expect(store.getState().phase).toBe('join')
    store
      .getState()
      .openEventAt({ id: 'friday', name: 'Harbour Fest', origin: 'http://10.0.0.9', pin: '4821' })
    expect(localStorage.getItem('crewbox:server-url')).toBe('http://10.0.0.9')
    expect(new URLSearchParams(location.search).get('pin')).toBe('4821')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('puts no PIN in the address when there is none to carry', async () => {
    inTheApp('http://10.0.0.2')
    const store = await loadStore()
    store.getState().openEventAt({ id: 'sunday', name: 'Quay Sessions', origin: 'http://10.0.0.9' })
    expect(location.search).toBe('')
    expect(reload).toHaveBeenCalledTimes(1)
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

describe('the open event’s box, found on the Wi-Fi at a new address and proven there', () => {
  const FOUND = 'Your box is at a new address, 10.0.0.9. This phone found it and carried on there.'

  beforeEach(() => {
    localStorage.setItem('crewbox:server-url', 'http://10.0.0.2')
    localStorage.setItem(
      'crewbox:boxes',
      JSON.stringify([{ id: 'friday', name: 'Harbour Fest', origin: 'http://10.0.0.2', seenAt: 1 }])
    )
  })

  it('is gone on with in place while nothing answers at the old address, and says so', async () => {
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await store.getState().boot()
    store.setState({ connection: 'offline' })

    store.getState().followBox('http://10.0.0.9', { found: true })
    expect(localStorage.getItem('crewbox:server-url')).toBe('http://10.0.0.9')
    expect(knownEvent('friday')?.origin).toBe('http://10.0.0.9')
    expect(socket!.restarts).toBe(1)
    expect(reload).not.toHaveBeenCalled()
    expect(store.getState().toasts).toMatchObject([{ message: FOUND, kind: 'info' }])
  })

  it('is left alone while this phone is reaching its box where it was', async () => {
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await store.getState().boot()
    socket!.onMessage(welcome('friday'))
    await settle()

    store.getState().followBox('http://10.0.0.9', { found: true })
    expect(localStorage.getItem('crewbox:server-url')).toBe('http://10.0.0.2')
    expect(knownEvent('friday')?.origin).toBe('http://10.0.0.2')
    expect(socket!.restarts).toBe(0)
    expect(store.getState().toasts).toEqual([])
  })

  it('is where the queue goes, and not the other event now at the old address', async () => {
    const store = await loadStore()
    await store.getState().boot()
    socket!.onMessage(welcome('spare'))
    await settle()
    expect(socket!.stopped).toBe(true)
    expect(sent).toEqual([])

    store.getState().followBox('http://10.0.0.9', { found: true })
    // A socket of its own, to the new address.
    expect(socket!.stopped).toBe(false)
    expect(store.getState().elsewhere).toBeNull()
    socket!.onMessage(welcome('friday'))
    await settle()
    expect(sent.map((m) => m.type)).toContain('logIncident')
    expect(store.getState()).toMatchObject({ connection: 'online', welcomedAt: 'http://10.0.0.9' })
  })
})
