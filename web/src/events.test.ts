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
let socket: {
  onMessage: (msg: unknown) => void
  hello: () => { token: string }
  stopped: boolean
  restarts: number
} | null = null

vi.mock('./lib/ws.ts', () => ({
  WsClient: class {
    handlers: { onMessage: (msg: unknown) => void }
    constructor(handlers: { onMessage: (msg: unknown) => void; hello: () => { token: string } }) {
      this.handlers = handlers
      socket = { onMessage: handlers.onMessage, hello: handlers.hello, stopped: false, restarts: 0 }
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
  join: vi.fn<
    () => Promise<{ token: string; eventId?: string; eventKey?: string; continues?: string }>
  >(),
  renewSession: vi.fn<(token: string, signal?: AbortSignal) => Promise<{ token: string }>>(),
}
vi.mock('./lib/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api.ts')>()),
  getConfig: () => api.getConfig(),
  join: () => api.join(),
  renewSession: (token: string, signal?: AbortSignal) => api.renewSession(token, signal),
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
  api.renewSession.mockReset()
  api.renewSession.mockRejectedValue(new TypeError('Failed to fetch'))
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

describe('a box saying which event it carries on', () => {
  // Its admin's word (Admin → This box): a spare with no backup, or a bigger
  // box, taking over from an event's box. Phones holding that event offer to
  // bring its work across once they have joined, at whatever address.

  /** Friday's welcome, from a box its admin says carries on `continues`. */
  const carrying = (eventId: string, continues: string, eventName?: string): WelcomeMessage => {
    const message = welcome(eventId, eventName)
    return { ...message, config: { ...message.config, continues } }
  }

  /** Thursday's event, held at another box's address. */
  async function holdThursday() {
    const { rememberEvent } = await import('./lib/eventScope.ts')
    rememberEvent({ id: 'thursday', name: 'Quay Stage', origin: 'http://10.0.0.4:8787', seenAt: 1 })
  }

  it('is offered once the phone is on the box, from the welcome', async () => {
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    const { toOffer } = await import('./lib/moveWork.ts')
    const { knownEvents } = await import('./lib/eventScope.ts')
    await holdThursday()
    await store.getState().boot()
    socket!.onMessage(carrying('friday', 'thursday'))
    await settle()
    expect(knownEvent('thursday')).toMatchObject({
      origin: 'http://10.0.0.4:8787',
      replacedBy: 'friday',
      continuedBy: 'friday',
    })
    expect(toOffer(knownEvents(), 'friday')?.id).toBe('thursday')
    // Nothing of Thursday's has gone anywhere by itself.
    expect(sent.map((m) => m.type)).not.toContain('send')
  })

  it('is heard live from a box already joined', async () => {
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await holdThursday()
    await store.getState().boot()
    socket!.onMessage(welcome('friday'))
    await settle()
    expect(knownEvent('thursday')?.continuedBy).toBeUndefined()
    socket!.onMessage({ type: 'config', config: { ...config('friday'), continues: 'thursday' } })
    expect(knownEvent('thursday')).toMatchObject({ replacedBy: 'friday', continuedBy: 'friday' })
  })

  it('is heard from the box’s config at the start, before the socket has said anything', async () => {
    api.getConfig.mockResolvedValue({ ...config('friday'), continues: 'thursday' })
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await holdThursday()
    await store.getState().boot()
    await settle()
    expect(knownEvent('thursday')).toMatchObject({ replacedBy: 'friday', continuedBy: 'friday' })
  })

  it('is taken only from the box running the open event', async () => {
    // A box at this address running another event can say what it likes;
    // nothing is offered until the crew member has joined it.
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await holdThursday()
    await store.getState().boot()
    socket!.onMessage(carrying('spare', 'thursday'))
    await settle()
    expect(knownEvent('thursday')?.continuedBy).toBeUndefined()
    expect(knownEvent('thursday')?.replacedBy).toBeUndefined()
  })

  it('says a box at this address carries on the open event, where its admin said so', async () => {
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await store.getState().boot()
    socket!.onMessage(carrying('spare', 'friday', 'Harbour Fest 2'))
    await settle()
    expect(sent).toEqual([])
    expect(store.getState().elsewhere).toEqual({
      id: 'spare',
      name: 'Harbour Fest 2',
      continues: 'friday',
      carriesOpen: true,
    })
    expect(knownEvent('friday')?.replacedBy).toBe('spare')
  })

  it('takes a box at this address carrying on another event as no stand-in for this one', async () => {
    // The next event's box, set up to carry on an event of its own: its
    // admin has said which, and it isn't this one.
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await store.getState().boot()
    socket!.onMessage(carrying('spare', 'thursday'))
    await settle()
    expect(store.getState().elsewhere).toEqual({
      id: 'spare',
      name: 'Harbour Fest',
      continues: 'thursday',
    })
    expect(knownEvent('friday')?.replacedBy).toBeUndefined()
    expect(knownEvent('spare')).toMatchObject({ origin: location.origin })
  })

  it('decides, on joining a box at this address, whether it stands in for the open event', async () => {
    /** Friday's record after joining the spare now at Friday's address. */
    const joinAt = async (continues?: string) => {
      localStorage.clear()
      localStorage.setItem('crewbox:db-epoch', 'friday')
      const store = await loadStore()
      const { knownEvent, rememberEvent } = await import('./lib/eventScope.ts')
      rememberEvent({ id: 'friday', name: 'Harbour Fest', origin: location.origin, seenAt: 1 })
      api.join.mockResolvedValue({
        token: 'spares-sign-in',
        eventId: 'spare',
        ...(continues ? { continues } : {}),
      })
      await store.getState().join('Sam', '4242', '1234')
      return knownEvent('friday')
    }
    // A guess from the address, which only Your boxes acts on...
    expect((await joinAt())?.replacedBy).toBe('spare')
    // ...its admin's word...
    expect((await joinAt('friday'))?.replacedBy).toBe('spare')
    // ...and its admin's word that it is some other event's.
    expect((await joinAt('thursday'))?.replacedBy).toBeUndefined()
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
    // A chat outbox that could not take the message, and no app to keep it:
    // the other event's copy is all there is, and must not be let go of.
    const store = await loadStore()
    const { cache } = await import('./lib/db.ts')
    vi.spyOn(cache, 'putOutbox').mockResolvedValue(false)
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

describe('joining from a poster that names its event and key', () => {
  // A phone signed out of Friday, whose crew member scanned the poster on
  // the wall (docs/DISCOVERY.md, "The join QR").
  beforeEach(() => localStorage.removeItem('crewbox:token'))
  afterEach(() => vi.unstubAllGlobals())
  const NOT_THE_POSTERS =
    /^The box at \S+ isn’t the one on this poster, so nothing has gone to it\./

  it('checks the box is the poster’s before the PIN goes, and keeps the poster’s key', async () => {
    const saturday = await aBox('saturday')
    // How many joins had been sent each time the box was asked to prove itself.
    const joinsWhenAsked: number[] = []
    const asked = answering((input) => {
      joinsWhenAsked.push(api.join.mock.calls.length)
      return saturday.answer(input)
    })
    api.join.mockResolvedValue({
      token: 'saturdays-sign-in',
      eventId: 'saturday',
      eventKey: saturday.key,
    })
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await store.getState().join('Sam', '4242', '1234', { id: 'saturday', key: saturday.key })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(new RegExp(`^${location.origin}/api/identity\\?nonce=`))
    expect(joinsWhenAsked).toEqual([0])
    expect(api.join).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('crewbox@saturday:token')).toBe('saturdays-sign-in')
    expect(knownEvent('saturday')).toMatchObject({ origin: location.origin, key: saturday.key })
  })

  it('sends no PIN to a box that isn’t the poster’s', async () => {
    const saturday = await aBox('saturday')
    const impostor = await aBox('saturday')
    const sunday = await aBox('sunday')
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    for (const [what, answer] of [
      ['signs with another key', impostor.answer],
      ['runs another event', sunday.answer],
      ['can’t sign at all', () => new Response('Not Found', { status: 404 })],
    ] as const) {
      answering(answer)
      await expect(
        store.getState().join('Sam', '4242', '1234', { id: 'saturday', key: saturday.key }),
        what
      ).rejects.toThrow(NOT_THE_POSTERS)
    }
    expect(api.join).not.toHaveBeenCalled()
    expect(knownEvent('saturday')).toBeUndefined()
    expect(localStorage.getItem('crewbox@saturday:token')).toBeNull()
  })

  it('says a box that doesn’t answer the check can’t be reached, and sends it nothing', async () => {
    const saturday = await aBox('saturday')
    answering(() => Promise.reject(new TypeError('Failed to fetch')))
    const store = await loadStore()
    await expect(
      store.getState().join('Sam', '4242', '1234', { id: 'saturday', key: saturday.key })
    ).rejects.toBeInstanceOf(TypeError)
    expect(api.join).not.toHaveBeenCalled()
  })

  it('joins a box that won’t sign for its address when the sign-in names the poster’s event and key', async () => {
    const saturday = await aBox('saturday')
    // A box behind a port forward: it won't sign for the address asked at.
    answering(() => new Response('{}', { status: 421 }))
    api.join.mockResolvedValue({
      token: 'saturdays-sign-in',
      eventId: 'saturday',
      eventKey: saturday.key,
    })
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await store.getState().join('Sam', '4242', '1234', { id: 'saturday', key: saturday.key })
    expect(localStorage.getItem('crewbox@saturday:token')).toBe('saturdays-sign-in')
    expect(knownEvent('saturday')?.key).toBe(saturday.key)
  })

  it('keeps no sign-in from such a box when it answers as another event, or with another key', async () => {
    const saturday = await aBox('saturday')
    const impostor = await aBox('saturday')
    answering(() => new Response('{}', { status: 421 }))
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    for (const joined of [
      { token: 'not-saturdays', eventId: 'saturday', eventKey: impostor.key },
      { token: 'not-saturdays', eventId: 'sunday', eventKey: saturday.key },
      { token: 'not-saturdays', eventId: 'saturday' },
      { token: 'not-saturdays' },
    ]) {
      api.join.mockResolvedValueOnce(joined)
      await expect(
        store.getState().join('Sam', '4242', '1234', { id: 'saturday', key: saturday.key }),
        JSON.stringify(joined)
      ).rejects.toThrow(/isn’t the one on this poster, so the app hasn’t kept its sign-in\./)
    }
    expect(api.join).toHaveBeenCalledTimes(4)
    for (const name of ['crewbox:token', 'crewbox@saturday:token', 'crewbox@sunday:token']) {
      expect(localStorage.getItem(name), name).toBeNull()
    }
    expect(knownEvent('saturday')).toBeUndefined()
    expect(knownEvent('sunday')).toBeUndefined()
    expect(localStorage.getItem('crewbox:event')).toBeNull()
  })

  it('asks nothing of the box when this phone holds the poster’s event with another key', async () => {
    const saturday = await aBox('saturday')
    const printed = await aBox('saturday')
    const asked = answering(printed.answer)
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await holdSaturday(saturday.key)
    await expect(
      store.getState().join('Sam', '4242', '1234', { id: 'saturday', key: printed.key })
    ).rejects.toThrow(
      /^This poster doesn’t match “Harbour Tour” as this phone knows it, so nothing has gone to the box at \S+\. If you are sure it is the event’s box, open it from Your boxes\.$/
    )
    expect(asked).toHaveLength(0)
    expect(api.join).not.toHaveBeenCalled()
    expect(knownEvent('saturday')).toMatchObject({
      origin: 'http://10.0.0.3:8787',
      key: saturday.key,
    })
  })

  /** Saturday, held at another address, and its box here proving it. */
  async function movesHere(kept: boolean) {
    const saturday = await aBox('saturday')
    answering(saturday.answer)
    api.join.mockResolvedValue({
      token: 'saturdays-sign-in',
      eventId: 'saturday',
      eventKey: saturday.key,
    })
    const store = await loadStore()
    const { knownEvent } = await import('./lib/eventScope.ts')
    await holdSaturday(kept ? saturday.key : undefined)
    await store.getState().join('Sam', '4242', '1234', { id: 'saturday', key: saturday.key })
    expect(knownEvent('saturday')).toMatchObject({ origin: location.origin, key: saturday.key })
    expect(localStorage.getItem('crewbox@saturday:token')).toBe('saturdays-sign-in')
    // The poster named the event: its box's config wasn't needed to say which.
    expect(api.getConfig).not.toHaveBeenCalled()
  }

  it('moves an event held elsewhere here once its box proves it with the key kept', async () => {
    await movesHere(true)
  })

  it('moves one held with no key kept here too, and keeps the poster’s', async () => {
    await movesHere(false)
  })
})

describe('in the apps, a sign-in the app keeps', () => {
  /** The app, its Keychain stood in for by a map, holding what a test gives it. */
  function inTheApp(kept: Record<string, string> = {}) {
    const keychain = new Map(Object.entries(kept))
    const alerts = {
      start: vi.fn(async (_options: Record<string, string>) => {}),
      stop: vi.fn(async () => {}),
    }
    ;(window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        // Each answers a turn later, as a call across the bridge does, so a
        // reload that doesn't wait for one happens before it has kept anything.
        CrewboxSessions: {
          load: async () => ({ sessions: Object.fromEntries(keychain) }),
          save: async ({ name, token }: { name: string; token: string }) => {
            await settle()
            keychain.set(name, token)
          },
          forget: async ({ name }: { name: string }) => {
            await settle()
            keychain.delete(name)
          },
        },
        CrewboxAlerts: alerts,
      },
    }
    localStorage.setItem('crewbox:server-url', 'http://10.0.0.2')
    return { keychain, alerts }
  }

  /** A page load in the app: the store, then its sign-ins, as main.tsx has it. */
  async function start() {
    const store = await loadStore()
    const sessions = await import('./lib/sessions.ts')
    await sessions.loadSessions()
    return { store, HELD: sessions.HELD }
  }

  afterEach(() => {
    delete (window as { Capacitor?: unknown }).Capacitor
  })

  it('moves the sign-in kept before into the app, and signs in with it', async () => {
    const { keychain } = inTheApp()
    const { store, HELD } = await start()
    expect(keychain.get('crewbox:token')).toBe('fridays-sign-in')
    expect(localStorage.getItem('crewbox:token')).toBe(HELD)
    await store.getState().boot()
    expect(store.getState().phase).toBe('chat')
    // Its box didn't answer the renewal: the old one works until it does.
    expect(api.renewSession).toHaveBeenCalledWith('fridays-sign-in', expect.any(AbortSignal))
    expect(socket!.hello().token).toBe('fridays-sign-in')
  })

  it('has its box renew the sign-in it moved before saying hello with it', async () => {
    // The page's storage goes in backups, so a copy of that one may be on
    // another phone: the box's new one is this phone's alone.
    const { keychain, alerts } = inTheApp()
    const renewed = 'r'.repeat(43)
    api.renewSession.mockImplementation(async (token) => {
      expect(socket).toBeNull()
      expect(token).toBe('fridays-sign-in')
      return { token: renewed }
    })
    const { store } = await start()
    await store.getState().boot()
    expect(api.renewSession).toHaveBeenCalledTimes(1)
    expect(keychain.get('crewbox:token')).toBe(renewed)
    expect(socket!.hello().token).toBe(renewed)
    socket!.onMessage(welcome('friday'))
    await settle()
    expect(alerts.start).toHaveBeenCalledWith(expect.objectContaining({ token: renewed }))
    // Once: the next start has nothing to renew.
    const again = await start()
    await again.store.getState().boot()
    expect(api.renewSession).toHaveBeenCalledTimes(1)
    expect(socket!.hello().token).toBe(renewed)
  })

  it('asks once the Android app has put the box’s traffic on the Wi-Fi', async () => {
    // Over mobile data, the ask would only fail.
    inTheApp()
    let say: () => void = () => {}
    const plugins = (window as unknown as { Capacitor: { Plugins: Record<string, unknown> } })
      .Capacitor.Plugins
    plugins.CrewboxNetwork = {
      useBox: () => new Promise((resolve) => (say = () => resolve({ onWifi: true }))),
    }
    api.renewSession.mockResolvedValue({ token: 'r'.repeat(43) })
    const { store } = await start()
    ;(await import('./lib/server.ts')).holdBoxWifi()
    const booted = store.getState().boot()
    await settle()
    await settle()
    expect(api.renewSession).not.toHaveBeenCalled()
    say()
    await booted
    expect(api.renewSession).toHaveBeenCalledTimes(1)
    expect(socket!.hello().token).toBe('r'.repeat(43))
  })

  it('waits a few seconds at most for its box, and says hello with the old one', async () => {
    inTheApp()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort())
    api.renewSession.mockImplementation(
      (_token, signal) =>
        new Promise((_, reject) => {
          if (signal?.aborted) reject(signal.reason)
          signal?.addEventListener('abort', () => reject(signal.reason))
        })
    )
    const { store } = await start()
    await store.getState().boot()
    expect(timeout).toHaveBeenCalledWith(4000)
    expect(socket!.hello().token).toBe('fridays-sign-in')
  })

  it('asks again at the next start when its box didn’t answer', async () => {
    const { keychain } = inTheApp()
    const first = await start()
    await first.store.getState().boot()
    expect(api.renewSession).toHaveBeenCalledTimes(1)
    const renewed = 'r'.repeat(43)
    api.renewSession.mockResolvedValue({ token: renewed })
    const again = await start()
    await again.store.getState().boot()
    expect(api.renewSession).toHaveBeenCalledTimes(2)
    expect(api.renewSession).toHaveBeenLastCalledWith('fridays-sign-in', expect.any(AbortSignal))
    expect(keychain.get('crewbox:token')).toBe(renewed)
    expect(socket!.hello().token).toBe(renewed)
  })

  it('renews nothing it didn’t move: a join’s sign-in was never in the page’s storage', async () => {
    localStorage.removeItem('crewbox:token')
    inTheApp()
    api.join.mockResolvedValue({ token: 'fridays-new-sign-in', eventId: 'friday' })
    const first = await start()
    await first.store.getState().join('Sam', '4242', '1234')
    const again = await start()
    await again.store.getState().boot()
    expect(api.renewSession).not.toHaveBeenCalled()
    expect(socket!.hello().token).toBe('fridays-new-sign-in')
  })

  it('keeps a join’s sign-in in the app, and hands the alerts service its name', async () => {
    localStorage.removeItem('crewbox:token')
    const { keychain, alerts } = inTheApp()
    api.join.mockResolvedValue({ token: 'fridays-new-sign-in', eventId: 'friday' })
    const { store, HELD } = await start()
    await store.getState().join('Sam', '4242', '1234')
    expect(keychain.get('crewbox:token')).toBe('fridays-new-sign-in')
    expect(localStorage.getItem('crewbox:token')).toBe(HELD)
    expect(socket!.hello().token).toBe('fridays-new-sign-in')
    socket!.onMessage(welcome('friday'))
    await settle()
    // Under which Android finds it again when it restarts the service.
    expect(alerts.start).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'fridays-new-sign-in', session: 'crewbox:token' })
    )
  })

  it('files another event’s sign-in with the app before it reloads into that event', async () => {
    localStorage.removeItem('crewbox:token')
    const { keychain } = inTheApp()
    api.join.mockResolvedValue({ token: 'saturdays-sign-in', eventId: 'saturday' })
    const { store, HELD } = await start()
    let keptAtReload: string | undefined
    reload.mockImplementation(() => (keptAtReload = keychain.get('crewbox@saturday:token')))
    await store.getState().join('Sam', '4242', '1234')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(keptAtReload).toBe('saturdays-sign-in')
    expect(localStorage.getItem('crewbox@saturday:token')).toBe(HELD)
  })

  it('forgets it in the app on signing out, before the reload', async () => {
    const { keychain } = inTheApp()
    const { store } = await start()
    let keptAtReload: string | undefined = 'not reloaded'
    reload.mockImplementation(() => (keptAtReload = keychain.get('crewbox:token')))
    await store.getState().logout()
    expect(keptAtReload).toBeUndefined()
    expect(localStorage.getItem('crewbox:token')).toBeNull()
  })

  it('forgets it in the app when the box ends the session', async () => {
    const { keychain } = inTheApp()
    api.getConfig.mockResolvedValue(config('friday'))
    const { store } = await start()
    await store.getState().sessionEnded()
    expect(keychain.has('crewbox:token')).toBe(false)
    expect(localStorage.getItem('crewbox:token')).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('starts signed out when a backup brought the page’s storage but not the app’s', async () => {
    // Another phone's backup: the page names a sign-in the app has never had.
    inTheApp()
    const sessions = await import('./lib/sessions.ts')
    localStorage.setItem('crewbox:token', sessions.HELD)
    const { store } = await start()
    await store.getState().boot()
    expect(store.getState().phase).toBe('join')
    expect(localStorage.getItem('crewbox:token')).toBeNull()
    // Everything else it brought is still there, for when this crew member signs in.
    expect(JSON.parse(localStorage.getItem('crewbox:incident-outbox')!)).toEqual([QUEUED])
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

describe('work this phone couldn’t save', () => {
  // Nothing here keeps a chat outbox (there is no IndexedDB) and there is no
  // app, so a message is kept nowhere a reload leaves it: a phone whose
  // storage refuses writes.
  // Undone by hand: restoreAllMocks leaves a spy on happy-dom's storage in place.
  let refusing: { mockRestore: () => void } | undefined
  const refuseShowLogQueue = () => {
    const setItem = localStorage.setItem.bind(localStorage)
    refusing = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.includes('incident-outbox')) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
      setItem(key, value)
    })
  }

  afterEach(() => {
    refusing?.mockRestore()
    refusing = undefined
  })

  beforeEach(() => {
    localStorage.setItem('crewbox:incident-outbox', '[]')
  })

  it('says a message isn’t saved on this phone, and still sends it at the next connection', async () => {
    const store = await loadStore()
    await store.getState().boot()
    store.getState().sendMessage('general', 'Doors in ten')
    await settle()
    const [waiting] = store.getState().pending['general'] ?? []
    expect(waiting).toMatchObject({ body: 'Doors in ten', unsaved: true })

    // The send before the socket was up went nowhere; the connection's flush
    // is what takes it, from what the page holds.
    sent.length = 0
    socket!.onMessage(welcome('friday'))
    await settle()
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'send', clientMsgId: waiting!.clientMsgId })
    )

    socket!.onMessage({
      type: 'ack',
      clientMsgId: waiting!.clientMsgId,
      message: {
        id: 'm1',
        channelId: 'general',
        seq: 1,
        authorId: 'u1',
        kind: 'text',
        body: 'Doors in ten',
        clientMsgId: waiting!.clientMsgId,
        createdAt: 2,
      },
    })
    await settle()
    expect(store.getState().pending['general'] ?? []).toEqual([])
    const { cache } = await import('./lib/db.ts')
    expect(await cache.loadOutbox()).toEqual([])
  })

  it('says a show-log entry isn’t saved until the box has it, and sends it all the same', async () => {
    const store = await loadStore()
    await store.getState().boot()
    refuseShowLogQueue()
    const { clientMsgId: _, ...typed } = QUEUED as QueuedIncident
    store.getState().logIncident(typed)
    await settle()
    const [id] = store.getState().unsavedEntries
    expect(id).toEqual(expect.any(String))
    const { queuedIncidents } = await import('./modules/incident/model/outbox.ts')
    expect(queuedIncidents().map((e) => e.clientMsgId)).toEqual([id])

    sent.length = 0
    socket!.onMessage(welcome('friday'))
    await settle()
    expect(sent).toContainEqual(expect.objectContaining({ type: 'logIncident', clientMsgId: id }))

    socket!.onMessage({ type: 'incident', incident: { id: 'i1', clientMsgId: id } })
    expect(store.getState().unsavedEntries).toEqual([])
    expect(queuedIncidents()).toEqual([])
  })

  it('says nothing of an entry the queue took', async () => {
    const store = await loadStore()
    await store.getState().boot()
    const { clientMsgId: _, ...typed } = QUEUED as QueuedIncident
    store.getState().logIncident(typed)
    await settle()
    expect(store.getState().unsavedEntries).toEqual([])
  })

  it('lets go of all of it on signing out, as the queues do', async () => {
    const store = await loadStore()
    await store.getState().boot()
    refuseShowLogQueue()
    store.getState().sendMessage('general', 'Doors in ten')
    const { clientMsgId: _, ...typed } = QUEUED as QueuedIncident
    store.getState().logIncident(typed)
    await settle()
    const { heldUnsent } = await import('./lib/unsent.ts')
    expect(heldUnsent('friday', 'messages')).toHaveLength(1)
    expect(heldUnsent('friday', 'entries')).toHaveLength(1)
    await store.getState().logout()
    expect(heldUnsent('friday', 'messages')).toEqual([])
    expect(heldUnsent('friday', 'entries')).toEqual([])
  })

  it('sends nothing brought across from another event that it couldn’t save, which stays there', async () => {
    const store = await loadStore()
    await store.getState().boot()
    const saved = await store
      .getState()
      .queueMoved(
        [{ clientMsgId: 'unsent', channelId: 'general-here', body: 'Doors in ten', createdAt: 1 }],
        []
      )
    expect(saved.has('unsent')).toBe(false)
    sent.length = 0
    socket!.onMessage(welcome('friday'))
    await settle()
    expect(sent).not.toContainEqual(expect.objectContaining({ clientMsgId: 'unsent' }))
  })
})
