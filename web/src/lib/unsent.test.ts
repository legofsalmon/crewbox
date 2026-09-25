// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboxEntry } from './db.ts'
import type { RecordsPlugin } from './server.ts'
import type { QueuedIncident } from '../modules/incident/model/outbox.ts'

/**
 * Unsent work as the page holds it (unsent.ts): in memory while it is open,
 * and in the apps in the app's files as well, a slot beside each event's
 * record. The files are a map of folders here, as in appCopy.test.ts, and
 * each test is a page loaded afresh.
 */

type Modules = {
  unsent: typeof import('./unsent.ts')
  checks: import('./unsent.ts').UnsentChecks
}

const message = (clientMsgId: string, fields: Partial<OutboxEntry> = {}): OutboxEntry => ({
  clientMsgId,
  channelId: 'general',
  body: `message ${clientMsgId}`,
  createdAt: 1,
  ...fields,
})

const entry = (clientMsgId: string, fields: Partial<QueuedIncident> = {}): QueuedIncident => ({
  clientMsgId,
  kind: 'note',
  severity: 'note',
  body: `entry ${clientMsgId}`,
  at: 1,
  stage: 'Main',
  actId: '',
  actName: '',
  ...fields,
})

/** The app's files: a folder per event, a file per slot. */
function files(folders: Record<string, Record<string, string>> = {}) {
  const kept = new Map(
    Object.entries(folders).map(([id, slots]) => [id, new Map(Object.entries(slots))])
  )
  const app = {
    kept,
    /** Writes and removes throw: a full disk. */
    refusing: false,
    /** Each write and remove, as `write friday/outbox`. */
    calls: [] as string[],
    /** What the next write waits for before it goes through, if anything. */
    gate: undefined as Promise<void> | undefined,
    readAll: vi.fn<RecordsPlugin['readAll']>(async ({ slot }) => {
      const values: Record<string, string> = {}
      for (const [id, slots] of kept) {
        const value = slots.get(slot)
        if (value !== undefined) values[id] = value
      }
      return { values }
    }),
    write: vi.fn<RecordsPlugin['write']>(async ({ event, slot, value }) => {
      app.calls.push(`write ${event}/${slot}`)
      const gate = app.gate
      app.gate = undefined
      await gate
      if (app.refusing) throw new Error('No space left on device')
      kept.set(event, (kept.get(event) ?? new Map<string, string>()).set(slot, value))
    }),
    remove: vi.fn<RecordsPlugin['remove']>(async ({ event, slot }) => {
      app.calls.push(`remove ${event}/${slot}`)
      if (app.refusing) throw new Error('No space left on device')
      if (slot) kept.get(event)?.delete(slot)
      else kept.delete(event)
    }),
  }
  return app
}

/** What one slot of the app's files holds, parsed. */
function slot(app: ReturnType<typeof files>, event: string, name: string): unknown {
  const text = app.kept.get(event)?.get(name)
  return text === undefined ? undefined : JSON.parse(text)
}

async function load(): Promise<Modules> {
  vi.resetModules()
  const { isOutboxEntry } = await import('./db.ts')
  const { isQueuedIncident } = await import('../modules/incident/model/outbox.ts')
  return {
    unsent: await import('./unsent.ts'),
    checks: { messages: isOutboxEntry, entries: isQueuedIncident },
  }
}

/** Let the queued writes run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('anywhere but the apps', () => {
  it('holds what is queued while the page is open, and says nothing else has it', async () => {
    const { unsent } = await load()
    await expect(unsent.holdUnsent('friday', 'messages', message('a'))).resolves.toBe(false)
    expect(unsent.heldUnsent('friday', 'messages')).toEqual([message('a')])
    expect(unsent.holdsUnsent('friday', 'messages', 'a')).toBe(true)
    expect(unsent.keepsUnsentInApp()).toBe(false)
  })

  it('reads a queue with what it holds that the page’s storage lacks, after the rest', async () => {
    const { unsent } = await load()
    void unsent.holdUnsent('friday', 'messages', message('a'))
    void unsent.holdUnsent('friday', 'messages', message('b'))
    expect(unsent.withHeld([], 'friday', 'messages')).toEqual([message('a'), message('b')])
    expect(unsent.withHeld([message('b'), message('c')], 'friday', 'messages')).toEqual([
      message('b'),
      message('c'),
      message('a'),
    ])
  })

  it('keeps each event’s work, and each kind, apart', async () => {
    const { unsent } = await load()
    void unsent.holdUnsent('friday', 'messages', message('a'))
    void unsent.holdUnsent('saturday', 'entries', entry('b'))
    expect(unsent.heldUnsent('saturday', 'messages')).toEqual([])
    expect(unsent.heldUnsent('friday', 'entries')).toEqual([])
    expect(unsent.withHeld([], 'saturday', 'entries')).toEqual([entry('b')])
  })

  it('lets go of what the box has, and of everything for a phone handed on', async () => {
    const { unsent } = await load()
    void unsent.holdUnsent('friday', 'messages', message('a'))
    void unsent.holdUnsent('friday', 'messages', message('b'))
    void unsent.holdUnsent('friday', 'entries', entry('c'))
    await unsent.releaseUnsent('friday', 'messages', ['a'])
    expect(unsent.heldUnsent('friday', 'messages')).toEqual([message('b')])

    expect(unsent.clearedCount('friday')).toBe(0)
    await unsent.releaseAllUnsent('friday')
    expect(unsent.heldUnsent('friday', 'messages')).toEqual([])
    expect(unsent.heldUnsent('friday', 'entries')).toEqual([])
    expect(unsent.clearedCount('friday')).toBe(1)
  })

  it('lets go of only the kinds it is told to', async () => {
    const { unsent } = await load()
    void unsent.holdUnsent('friday', 'messages', message('a'))
    void unsent.holdUnsent('friday', 'entries', entry('b'))
    await unsent.releaseAllUnsent('friday', ['entries'])
    expect(unsent.heldUnsent('friday', 'messages')).toEqual([message('a')])
    expect(unsent.heldUnsent('friday', 'entries')).toEqual([])
  })

  it('remembers what it let go of until it holds it again', async () => {
    // So that something that read a queue before an item went doesn't hold
    // it again once the box has it.
    const { unsent } = await load()
    expect(unsent.wasReleased('friday', 'messages', 'a')).toBe(false)
    await unsent.releaseUnsent('friday', 'messages', ['a'])
    expect(unsent.wasReleased('friday', 'messages', 'a')).toBe(true)
    expect(unsent.wasReleased('friday', 'entries', 'a')).toBe(false)
    expect(unsent.wasReleased('saturday', 'messages', 'a')).toBe(false)
    void unsent.holdUnsent('friday', 'messages', message('a'))
    expect(unsent.wasReleased('friday', 'messages', 'a')).toBe(false)
  })
})

describe('in the apps', () => {
  it('holds what the app’s files have from the start on', async () => {
    const app = files({
      friday: {
        outbox: JSON.stringify([message('a'), message('b')]),
        'incident-outbox': JSON.stringify([entry('c')]),
      },
      saturday: { outbox: JSON.stringify([message('d')]) },
    })
    const { unsent, checks } = await load()
    await expect(unsent.loadUnsent(app, checks)).resolves.toBe(true)
    expect(app.readAll).toHaveBeenCalledWith({ slot: 'outbox' })
    expect(app.readAll).toHaveBeenCalledWith({ slot: 'incident-outbox' })
    expect(unsent.heldUnsent('friday', 'messages')).toEqual([message('a'), message('b')])
    expect(unsent.heldUnsent('friday', 'entries')).toEqual([entry('c')])
    expect(unsent.heldUnsent('saturday', 'messages')).toEqual([message('d')])
    expect(unsent.keepsUnsentInApp()).toBe(true)
  })

  it('takes nothing from the files that isn’t work of an event’s', async () => {
    const app = files({
      friday: {
        outbox: JSON.stringify([
          message('a'),
          { clientMsgId: '', channelId: 'general', body: 'no ID', createdAt: 1 },
          { clientMsgId: 'e', body: 'no channel', createdAt: 1 },
          'a line of text',
          null,
        ]),
        'incident-outbox': JSON.stringify([entry('b'), entry('f', { body: '' })]),
      },
      saturday: { outbox: '{"not": "a queue"}', 'incident-outbox': 'not JSON at all' },
      '../elsewhere': { outbox: JSON.stringify([message('g')]) },
    })
    const { unsent, checks } = await load()
    await unsent.loadUnsent(app, checks)
    expect(unsent.heldUnsent('friday', 'messages')).toEqual([message('a')])
    expect(unsent.heldUnsent('friday', 'entries')).toEqual([entry('b')])
    expect(unsent.heldUnsent('saturday', 'messages')).toEqual([])
    expect(unsent.heldUnsent('saturday', 'entries')).toEqual([])
    expect(unsent.heldUnsent('../elsewhere', 'messages')).toEqual([])
  })

  it('has the app keep each event’s work whole, in place of what was there', async () => {
    const app = files()
    const { unsent, checks } = await load()
    await unsent.loadUnsent(app, checks)
    await expect(unsent.holdUnsent('friday', 'messages', message('a'))).resolves.toBe(true)
    expect(slot(app, 'friday', 'outbox')).toEqual([message('a')])
    await unsent.holdUnsent('friday', 'messages', message('b'))
    expect(slot(app, 'friday', 'outbox')).toEqual([message('a'), message('b')])
    await unsent.holdUnsent('friday', 'entries', entry('c'))
    expect(slot(app, 'friday', 'incident-outbox')).toEqual([entry('c')])

    await unsent.releaseUnsent('friday', 'messages', ['a'])
    expect(slot(app, 'friday', 'outbox')).toEqual([message('b')])
    // The last one gone, the slot goes: nothing is kept of an empty queue.
    await unsent.releaseUnsent('friday', 'messages', ['b'])
    expect(app.kept.get('friday')?.has('outbox')).toBe(false)
    expect(app.remove).toHaveBeenLastCalledWith({ event: 'friday', slot: 'outbox' })
    expect(slot(app, 'friday', 'incident-outbox')).toEqual([entry('c')])
  })

  it('asks nothing of the app for an item it doesn’t hold', async () => {
    const app = files()
    const { unsent, checks } = await load()
    await unsent.loadUnsent(app, checks)
    await unsent.releaseUnsent('friday', 'messages', ['never-held'])
    expect(app.calls).toEqual([])
  })

  it('writes one at a time, and what is held meanwhile goes with the write waiting', async () => {
    const app = files()
    const { unsent, checks } = await load()
    await unsent.loadUnsent(app, checks)
    let open!: () => void
    app.gate = new Promise((resolve) => (open = resolve))
    const first = unsent.holdUnsent('friday', 'messages', message('a'))
    await settle()
    expect(app.calls).toEqual(['write friday/outbox'])

    const second = unsent.holdUnsent('friday', 'messages', message('b'))
    const third = unsent.holdUnsent('friday', 'messages', message('c'))
    await settle()
    // Nothing more until the first is through.
    expect(app.calls).toEqual(['write friday/outbox'])
    open()
    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true])
    expect(app.calls).toEqual(['write friday/outbox', 'write friday/outbox'])
    expect(slot(app, 'friday', 'outbox')).toEqual([message('a'), message('b'), message('c')])
  })

  it('says so when the app couldn’t keep it, and holds it all the same', async () => {
    const app = files()
    const { unsent, checks } = await load()
    await unsent.loadUnsent(app, checks)
    app.refusing = true
    await expect(unsent.holdUnsent('friday', 'entries', entry('a'))).resolves.toBe(false)
    expect(unsent.heldUnsent('friday', 'entries')).toEqual([entry('a')])
    app.refusing = false
    await expect(unsent.holdUnsent('friday', 'entries', entry('b'))).resolves.toBe(true)
    expect(slot(app, 'friday', 'incident-outbox')).toEqual([entry('a'), entry('b')])
  })

  it('tells the app of a phone handed on though it holds nothing, in case a failed write left something', async () => {
    const app = files()
    const { unsent, checks } = await load()
    await unsent.loadUnsent(app, checks)
    app.kept.set('friday', new Map([['outbox', JSON.stringify([message('left-behind')])]]))
    await unsent.releaseAllUnsent('friday')
    expect(app.calls).toEqual(['remove friday/outbox', 'remove friday/incident-outbox'])
    expect(app.kept.get('friday')?.size).toBe(0)
  })

  it('files nothing for a device not told its event yet, and holds it all the same', async () => {
    const app = files()
    const { unsent, checks } = await load()
    await unsent.loadUnsent(app, checks)
    await expect(unsent.holdUnsent(null, 'messages', message('a'))).resolves.toBe(false)
    expect(unsent.heldUnsent(null, 'messages')).toEqual([message('a')])
    expect(app.calls).toEqual([])
  })

  it('leaves alone files it couldn’t read at the start', async () => {
    // It can't tell what they have, and a write would replace it.
    const app = files({ friday: { outbox: JSON.stringify([message('a')]) } })
    app.readAll.mockRejectedValue(new Error('The files answered nothing'))
    const { unsent, checks } = await load()
    await expect(unsent.loadUnsent(app, checks)).resolves.toBe(false)
    await expect(unsent.holdUnsent('friday', 'messages', message('b'))).resolves.toBe(false)
    await unsent.releaseAllUnsent('friday')
    expect(app.calls).toEqual([])
    expect(slot(app, 'friday', 'outbox')).toEqual([message('a')])
    expect(unsent.keepsUnsentInApp()).toBe(false)
  })

  it('gives up on files that don’t answer within a few seconds', async () => {
    vi.useFakeTimers()
    const app = files()
    app.readAll.mockReturnValue(new Promise(() => {}))
    const { unsent, checks } = await load()
    const loading = unsent.loadUnsent(app, checks)
    await vi.advanceTimersByTimeAsync(4999)
    let answered = false
    void loading.then(() => (answered = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(answered).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(loading).resolves.toBe(false)
    await expect(unsent.holdUnsent('friday', 'messages', message('a'))).resolves.toBe(false)
    expect(app.calls).toEqual([])
  })
})
