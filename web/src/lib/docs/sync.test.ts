// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

/**
 * When a document starts syncing, and with which box.
 *
 * A document is the open event's alone (lib/eventScope.ts). It used to start
 * syncing the moment there was a session token, before the box had said
 * which event it was running, so a phone whose address now led to a spare
 * box with a fresh database — or to the next event's box — offered it every
 * sheet it had open, and the running order, which every device opens. Now a
 * document waits for a welcome from the open event's box, names the event
 * to the relay, and lets go when the box turns out to be another.
 */

const made: { room: string; params: Record<string, string>; destroyed: boolean }[] = []

vi.mock('y-websocket', () => ({
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
    constructor(_url: string, room: string, _doc: Y.Doc, opts: { params: Record<string, string> }) {
      this.entry = { room, params: opts.params, destroyed: false }
      made.push(this.entry)
    }
    on() {}
    destroy() {
      this.entry.destroyed = true
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

    useStore.setState({ hasConnected: true })
    expect(made.map((p) => p.room)).toEqual(['patch/sheet-a'])
  })

  it('tells the relay which event it belongs to', async () => {
    const { useStore, syncManager } = await load()
    useStore.setState({ hasConnected: true })
    syncManager.attach('timetable/event', new Y.Doc(), { present: false })
    expect(made[0]!.params).toEqual({ token: 'fridays-sign-in', event: 'friday' })
  })

  it('names no event on a phone that has never been told one', async () => {
    // A box too old to say which event it is: the relay is asked nothing
    // it could not answer, as before.
    localStorage.removeItem('crewbox:db-epoch')
    const { useStore, syncManager } = await load()
    useStore.setState({ hasConnected: true })
    syncManager.attach('patch/sheet-a', new Y.Doc())
    expect(made[0]!.params).toEqual({ token: 'fridays-sign-in' })
  })

  it('lets go of the box when it turns out to be running another event', async () => {
    const { useStore, syncManager } = await load()
    useStore.setState({ hasConnected: true })
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
})
