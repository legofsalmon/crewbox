import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { whenPersisted } from './persistence.ts'

/**
 * `IndexeddbPersistence.whenSynced` resolves on the 'synced' event and
 * **never rejects**, so a browser that has IndexedDB and refuses to open it
 * — a corrupted profile, a private window, a quota that has run out — left
 * that promise pending for the life of the tab. Both call sites had a
 * rejection handler on it and a comment saying it "resolves either way";
 * neither was true, and a pane awaiting it sat on "Loading sheet…" for ever.
 */

/** A `whenSynced` that behaves like the library's: resolve-only. */
const never = () => new Promise<void>(() => {})

// Fake timers throughout, so `settles` can flush the microtask queue the
// same way in every test — including the one about the timeout.
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** Has this promise resolved by now, whenever "now" is? */
const settles = async (promise: Promise<void>): Promise<boolean> => {
  let done = false
  void promise.then(() => {
    done = true
  })
  await vi.advanceTimersByTimeAsync(0)
  return done
}

describe('waiting for a local copy', () => {
  it('gives up when the database will not open', async () => {
    // The case that hung. `whenSynced` never fires, so the open is the only
    // place the failure is observable.
    const local = { whenSynced: never(), _db: Promise.reject(new Error('QuotaExceeded')) }
    expect(await settles(whenPersisted(local))).toBe(true)
  })

  it('waits for the read once the database is open', async () => {
    // Resolving early here would render the pane empty and then pop the
    // persisted state in underneath whoever was reading it.
    let synced!: () => void
    const local = {
      whenSynced: new Promise<void>((resolve) => (synced = resolve)),
      _db: Promise.resolve({}),
    }
    const ready = whenPersisted(local)
    expect(await settles(ready)).toBe(false)
    synced()
    expect(await settles(ready)).toBe(true)
  })

  it('does not wait for ever on an open that never reads', async () => {
    // The third case nobody can enumerate. The document is on the relay and
    // perfectly usable; persistence is an accelerator.
    const local = { whenSynced: never(), _db: Promise.resolve({}) }
    const ready = whenPersisted(local, 10_000)
    expect(await settles(ready)).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await settles(ready)).toBe(true)
  })

  it('is instant with no local copy at all', async () => {
    expect(await settles(whenPersisted(null))).toBe(true)
  })
})
