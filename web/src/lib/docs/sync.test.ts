// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'

/**
 * When a document starts syncing, and with which box.
 *
 * A document is the open event's alone (lib/eventScope.ts). It used to start
 * syncing the moment there was a session token, before the box had said
 * which event it was running, so a phone whose address now led to a spare
 * box with a fresh database — or to the next event's box — offered it every
 * sheet it had open, and the running order, which every device opens. Now a
 * document waits for a welcome from the open event's box, names the event
 * to the relay, and lets go when the box turns out to be another. And when
 * the box turns out to be somewhere else, it goes there with the page, once
 * the box there has let the phone in too.
 */

/** How y-websocket has a provider read a message of one type. */
type Handler = (
  encoder: encoding.Encoder,
  decoder: decoding.Decoder,
  provider: unknown,
  emitSynced: boolean,
  messageType: number
) => void

const made: {
  url: string
  room: string
  params: Record<string, string>
  destroyed: boolean
  connected: boolean
  calls: string[]
  /** Its readers by message type, as the page left them. */
  handlers: Handler[]
  /** Its own reading of sync messages, and where each one started. */
  read: Handler
  readAt: number[]
  emit: (name: string, value: unknown) => void
}[] = []

/** Things done in order, across providers and the app's copy of edits. */
const log: string[] = []

vi.mock('y-websocket', () => ({
  messageSync: 0,
  WebsocketProvider: class {
    awareness = {
      on() {},
      setLocalState() {},
      getLocalState: () => null,
      setLocalStateField() {},
      getStates: () => new Map(),
      clientID: 1,
    }
    entry: (typeof made)[number]
    listeners = new Map<string, ((value: unknown) => void)[]>()
    messageHandlers: Handler[]
    constructor(url: string, room: string, _doc: Y.Doc, opts: { params: Record<string, string> }) {
      const readAt: number[] = []
      const read: Handler = (_encoder, decoder) => {
        readAt.push(decoder.pos)
        log.push(`read ${room}`)
      }
      this.messageHandlers = [read]
      this.entry = {
        url,
        room,
        params: opts.params,
        destroyed: false,
        connected: false,
        calls: [],
        handlers: this.messageHandlers,
        read,
        readAt,
        emit: (name, value) => {
          for (const listener of this.listeners.get(name) ?? []) listener(value)
        },
      }
      made.push(this.entry)
    }
    get wsconnected() {
      return this.entry.connected
    }
    on(name: string, listener: (value: unknown) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
    }
    connect() {
      this.entry.calls.push('connect')
    }
    disconnect() {
      this.entry.calls.push('disconnect')
    }
    destroy() {
      this.entry.destroyed = true
      log.push(`destroy ${this.entry.room}`)
    }
  },
}))

// The chat socket a follow opens to the new address, which these tests stand in for.
vi.mock('../ws.ts', () => ({
  WsClient: class {
    start() {}
    stop() {}
    restart() {}
    reconnectNow() {}
    send() {
      return false
    }
  },
}))

async function load() {
  vi.resetModules()
  const { useStore } = await import('../../store.ts')
  const { syncManager } = await import('./sync.ts')
  return { useStore, syncManager }
}

beforeEach(() => {
  made.length = 0
  log.length = 0
  localStorage.clear()
  localStorage.setItem('crewbox:db-epoch', 'friday')
  localStorage.setItem('crewbox:token', 'fridays-sign-in')
})

afterEach(() => localStorage.clear())

describe('a document on a signed-in phone', () => {
  it('waits for the box to let the phone in before it syncs', async () => {
    const { useStore, syncManager } = await load()
    syncManager.attach('patch/sheet-a', new Y.Doc())
    expect(made).toEqual([])

    useStore.setState({ hasConnected: true, welcomedAt: location.origin })
    expect(made.map((p) => p.room)).toEqual(['patch/sheet-a'])
  })

  it('tells the relay which event it belongs to', async () => {
    const { useStore, syncManager } = await load()
    useStore.setState({ hasConnected: true, welcomedAt: location.origin })
    syncManager.attach('timetable/event', new Y.Doc(), { present: false })
    expect(made[0]!.params).toEqual({ token: 'fridays-sign-in', event: 'friday' })
  })

  it('names no event on a phone that has never been told one', async () => {
    // A box too old to say which event it is: the relay is asked nothing
    // it could not answer, as before.
    localStorage.removeItem('crewbox:db-epoch')
    const { useStore, syncManager } = await load()
    useStore.setState({ hasConnected: true, welcomedAt: location.origin })
    syncManager.attach('patch/sheet-a', new Y.Doc())
    expect(made[0]!.params).toEqual({ token: 'fridays-sign-in' })
  })

  it('lets go of the box when it turns out to be running another event', async () => {
    const { useStore, syncManager } = await load()
    useStore.setState({ hasConnected: true, welcomedAt: location.origin })
    syncManager.attach('patch/sheet-a', new Y.Doc())
    syncManager.attach('timetable/event', new Y.Doc(), { present: false })
    expect(made).toHaveLength(2)

    useStore.setState({ elsewhere: { id: 'spare', name: '' } })
    expect(made.every((p) => p.destroyed)).toBe(true)
    // And does not start again by itself, whatever else changes.
    useStore.setState({ me: { id: 'u1', name: 'Sam' } as never })
    syncManager.attach('patch/sheet-b', new Y.Doc())
    expect(made).toHaveLength(2)
  })

  it('goes with its box to a new address, once the box there has let the phone in', async () => {
    const { useStore, syncManager } = await load()
    useStore.setState({ hasConnected: true, welcomedAt: location.origin, phase: 'chat' })
    syncManager.attach('patch/sheet-a', new Y.Doc())
    expect(made.map((p) => p.url)).toEqual([`ws://${location.host}/ws/docs`])

    // The box proved itself there (lib/follow.ts). Nothing stays bound to
    // the old address, and nothing goes to the new one before its welcome.
    useStore.getState().followBox('http://10.0.0.9:8080', { found: true })
    expect(made[0]!.destroyed).toBe(true)
    expect(made).toHaveLength(1)

    useStore.setState({ welcomedAt: 'http://10.0.0.9:8080' })
    expect(made).toHaveLength(2)
    expect(made[1]).toMatchObject({
      url: 'ws://10.0.0.9:8080/ws/docs',
      room: 'patch/sheet-a',
      destroyed: false,
    })
  })
})

describe('a room still trying to reach the box', () => {
  it('starts again at once when the network comes back, or the Android app’s traffic moves', async () => {
    const { useStore, syncManager } = await load()
    useStore.setState({ hasConnected: true, welcomedAt: location.origin })
    syncManager.attach('patch/sheet-a', new Y.Doc())
    syncManager.attach('timetable/event', new Y.Doc(), { present: false })
    made[1]!.connected = true

    // The sheet's socket went out the old way and is hanging there; the
    // running order's works, and keeps the network it opened on.
    window.dispatchEvent(new Event('online'))
    expect(made[0]!.calls).toEqual(['disconnect', 'connect'])
    expect(made[1]!.calls).toEqual([])
  })
})

describe('a room in the apps', () => {
  afterEach(() => {
    vi.doUnmock('./unsentEdits.ts')
  })

  /** The page, with the app's copy of unconfirmed edits (unsentEdits.ts) stood in for. */
  async function loadKeeping(keeps: boolean) {
    const actual = await vi.importActual<typeof import('./unsentEdits.ts')>('./unsentEdits.ts')
    const edits = {
      ...actual,
      keepsEditsInApp: () => keeps,
      watchEdits: vi.fn((room: string) => log.push(`watch ${room}`)),
      unwatchEdits: vi.fn((room: string) => log.push(`unwatch ${room}`)),
      heardFromRelay: vi.fn((room: string) => log.push(`heard ${room}`)),
      relayInStep: vi.fn(),
    }
    vi.doMock('./unsentEdits.ts', () => edits)
    return { ...(await load()), edits }
  }

  /** A sync message from the relay, as the provider is handed it: after its type. */
  function fromRelay(bytes: number[]): decoding.Decoder {
    const decoder = decoding.createDecoder(new Uint8Array([0, ...bytes]))
    decoding.readVarUint(decoder)
    return decoder
  }

  it('is watched from before it can sync to after it stops', async () => {
    const { useStore, syncManager, edits } = await loadKeeping(true)
    const doc = new Y.Doc()
    syncManager.attach('patch/sheet-a', doc)
    expect(edits.watchEdits).toHaveBeenCalledWith('patch/sheet-a', doc)
    useStore.setState({ hasConnected: true, welcomedAt: location.origin })
    expect(made).toHaveLength(1)

    syncManager.detach('patch/sheet-a')
    // Its socket gone first, and with it what the relay could still send back.
    expect(log).toEqual(['watch patch/sheet-a', 'destroy patch/sheet-a', 'unwatch patch/sheet-a'])
  })

  it('shows the app’s copy each sync message the relay sends, once the provider has read it', async () => {
    const { useStore, syncManager, edits } = await loadKeeping(true)
    useStore.setState({ hasConnected: true, welcomedAt: location.origin })
    syncManager.attach('timetable/event', new Y.Doc(), { present: false })
    const provider = made[0]!
    const read = provider.handlers[0]!
    expect(read).not.toBe(provider.read)

    // An update of three bytes: the provider reads it from where it starts.
    const encoder = encoding.createEncoder()
    read(encoder, fromRelay([2, 3, 7, 8, 9]), provider, true, 0)
    expect(provider.readAt).toEqual([1])
    expect(edits.heardFromRelay).toHaveBeenCalledWith('timetable/event', {
      type: 2,
      payload: new Uint8Array([7, 8, 9]),
    })
    expect(log.slice(-2)).toEqual(['read timetable/event', 'heard timetable/event'])

    // Another tab of the page's is not the relay.
    read(encoder, fromRelay([2, 1, 7]), provider, false, 0)
    expect(provider.readAt).toEqual([1, 1])
    expect(edits.heardFromRelay).toHaveBeenCalledTimes(1)

    provider.emit('sync', true)
    provider.emit('sync', false)
    expect(edits.relayInStep.mock.calls).toEqual([
      ['timetable/event', true],
      ['timetable/event', false],
    ])
  })

  it('is left to the provider alone in a browser', async () => {
    const { useStore, syncManager, edits } = await loadKeeping(false)
    useStore.setState({ hasConnected: true, welcomedAt: location.origin })
    syncManager.attach('patch/sheet-a', new Y.Doc())
    expect(made[0]!.handlers[0]).toBe(made[0]!.read)
    made[0]!.emit('sync', true)
    expect(edits.relayInStep).not.toHaveBeenCalled()
  })
})
