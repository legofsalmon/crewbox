import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * A browser that will not open IndexedDB.
 *
 * It refuses by rejecting the first thing you ask it, and every caller here
 * was one of two kinds that a rejection ruins. `boot()` awaited three cache
 * loads with no catch, and `App.tsx` calls `boot()` with `void` — so a
 * corrupted Chrome profile, a private window or a browser set to block site
 * data left `phase` on its initial value for ever: no join form, no socket,
 * no message, on the one screen with nothing on it to explain itself. The
 * docs and timetable stores gate a `loaded` flag on persistence, which then
 * never settles and leaves a pane waiting on a promise that already failed.
 *
 * A contract of "the caller remembers to catch" had failed in three separate
 * places, so the cache is total instead: reads answer as if empty, writes do
 * nothing, and the app carries on and reconciles from the welcome.
 */

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('dexie')
})

/** Dexie as a browser that has refused to open the database. */
const mockBrokenDexie = (mode: 'reject' | 'throw') => {
  const fail = () => {
    const err = new Error('UnknownError: Internal error opening backing store')
    if (mode === 'throw') throw err
    return Promise.reject(err)
  }
  const table = {
    bulkPut: fail,
    bulkDelete: fail,
    put: fail,
    delete: fail,
    get: fail,
    clear: fail,
    orderBy: () => ({ toArray: fail }),
    where: () => ({ between: () => ({ delete: fail }) }),
  }
  class BrokenDexie {
    messages = table
    outbox = table
    kv = table
    version() {
      return { stores: () => undefined }
    }
  }
  vi.doMock('dexie', () => ({ default: BrokenDexie }))
}

const loadCache = async () => (await import('../src/lib/db.ts')).cache

describe.each(['reject', 'throw'] as const)('when IndexedDB %ss', (mode) => {
  it('answers reads as empty rather than failing', async () => {
    mockBrokenDexie(mode)
    const cache = await loadCache()
    await expect(cache.loadMessages()).resolves.toEqual([])
    await expect(cache.loadOutbox()).resolves.toEqual([])
    await expect(cache.loadSnapshot()).resolves.toBeUndefined()
  })

  it('lets the three loads boot does run to completion together', async () => {
    // The exact shape of the hang: `Promise.all` of all three, awaited in a
    // function nothing catches.
    mockBrokenDexie(mode)
    const cache = await loadCache()
    const [snapshot, messages, outbox] = await Promise.all([
      cache.loadSnapshot(),
      cache.loadMessages(),
      cache.loadOutbox(),
    ])
    expect(snapshot).toBeUndefined()
    expect(messages).toEqual([])
    expect(outbox).toEqual([])
  })

  it('lets writes go nowhere quietly', async () => {
    // A phone with no cache still sends: the outbox is an accelerator for
    // surviving a reload, not the thing that puts a message on the wire.
    mockBrokenDexie(mode)
    const cache = await loadCache()
    await expect(
      cache.putOutbox({
        clientMsgId: 'm1',
        channelId: 'general',
        body: 'gate 3 is clear',
        createdAt: 1,
      })
    ).resolves.toBeUndefined()
    await expect(cache.deleteOutbox('m1')).resolves.toBeUndefined()
    await expect(cache.saveMessages([{ id: 'x' } as never])).resolves.toBeUndefined()
    await expect(cache.deleteMessages(['x'])).resolves.toBeUndefined()
    await expect(cache.clearChannel('general')).resolves.toBeUndefined()
    await expect(
      cache.saveSnapshot({ me: null, users: [], channels: [], readState: {} })
    ).resolves.toBeUndefined()
    await expect(cache.prune()).resolves.toBeUndefined()
    await expect(cache.wipe()).resolves.toBeUndefined()
  })

  it('skips the work entirely when there is nothing to write', async () => {
    mockBrokenDexie(mode)
    const cache = await loadCache()
    await expect(cache.saveMessages([])).resolves.toBeUndefined()
    await expect(cache.deleteMessages([])).resolves.toBeUndefined()
  })
})
