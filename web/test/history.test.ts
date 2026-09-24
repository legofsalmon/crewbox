import { describe, expect, it } from 'vitest'
import { cacheable, needsBackfill, pageFrom } from '../src/lib/history.ts'

/**
 * The channel that showed "No messages yet" for ever.
 *
 * The box bounds the whole welcome with a global budget and names what did
 * not fit in `truncated`; the hub's comment says the client backfills those
 * over REST. No such code existed — and paging backwards needs a message to
 * page back *from*, which a truncated channel that got nothing has none of.
 * So the channel that most needed history was the one that refused to fetch
 * any, and any phone joining a box with a few hundred messages across its
 * channels saw it.
 */

describe('where to page from', () => {
  it('pages back from the oldest message held', () => {
    expect(pageFrom({ earliestSeq: 42, lastSeq: 300 })).toBe(42)
  })

  it('stops at the first message there has ever been', () => {
    // Holding seq 1 means there is nothing older, whatever lastSeq says.
    expect(pageFrom({ earliestSeq: 1, lastSeq: 300 })).toBeNull()
  })

  it('pages from the top when nothing is held at all', () => {
    // The case that was refused. `lastSeq` is knowable without holding any
    // of it, which is the whole point — it comes down in every welcome.
    expect(pageFrom({ earliestSeq: undefined, lastSeq: 300 })).toBe(301)
  })

  it('asks for nothing when the channel really is empty', () => {
    // A channel nobody has posted in is not the same as one this phone was
    // not sent, and `lastSeq` is what tells them apart.
    expect(pageFrom({ earliestSeq: undefined, lastSeq: 0 })).toBeNull()
  })

  it('asks for the one message a channel with a single post has', () => {
    expect(pageFrom({ earliestSeq: undefined, lastSeq: 1 })).toBe(2)
  })

  it('stops asking once a page has come back empty', () => {
    // The oldest message held is seq 2 and always will be: seq 1 was
    // deleted. `earliestSeq > 1` stays true for ever, so the scroll handler
    // asked, got nothing, and asked again on the very next scroll event —
    // a request per scroll frame, for the life of the session, on whichever
    // channel somebody happened to be reading.
    expect(pageFrom({ earliestSeq: 2, lastSeq: 300 })).toBe(2)
    expect(pageFrom({ earliestSeq: 2, lastSeq: 300, exhausted: true })).toBeNull()
  })

  it('stops asking from the top too, on a channel that came back empty', () => {
    // The same loop reached the other way: a channel whose messages have
    // all been deleted still carries a non-zero lastSeq.
    expect(pageFrom({ earliestSeq: undefined, lastSeq: 300, exhausted: true })).toBeNull()
  })
})

describe('what may be written to the durable cache', () => {
  /**
   * A search jump puts a detached block on screen — messages around seq 400
   * with nothing between them and the cached tail. Paging older from there
   * fetches a block contiguous with the *jump*, so writing it left the cache
   * reading 1-50, 380-420, 900-1000 after a reload, with nothing saying
   * anything was missing and no scroll that would ever fill it. On screen
   * the block is fine; it is the copy that outlives the session that has to
   * stay honest.
   */
  it('refuses a page fetched from a search jump', () => {
    expect(cacheable(true)).toBe(false)
  })

  it('keeps ordinary scrollback', () => {
    // Which is the case that matters for a phone rejoining in the morning:
    // paging back through a contiguous view fills the cache as it always did.
    expect(cacheable(false)).toBe(true)
  })
})

describe('which truncated channels need fetching now', () => {
  it('picks the ones holding nothing', () => {
    expect(needsBackfill(['a', 'b'], { a: { length: 0 }, b: undefined })).toEqual(['a', 'b'])
  })

  it('leaves alone one that got its tail', () => {
    // Truncated but not empty: there is something on screen, and scrolling
    // pages back from it. A request now would be for a channel nobody has
    // looked at, over the uplink the welcome just came down.
    expect(needsBackfill(['a'], { a: { length: 200 } })).toEqual([])
  })

  it('says nothing when nothing was truncated', () => {
    expect(needsBackfill([], { a: { length: 0 } })).toEqual([])
  })

  it('handles a channel the snapshot has not caught up with', () => {
    expect(needsBackfill(['ghost'], {})).toEqual(['ghost'])
  })
})
