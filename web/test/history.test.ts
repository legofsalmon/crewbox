import { describe, expect, it } from 'vitest'
import { databaseChanged, needsBackfill, pageFrom } from '../src/lib/history.ts'

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

describe('a box whose database changed underneath', () => {
  /**
   * Restoring a backup, or swapping to the spare box, brings a *different*
   * database — and a resume cursor is a bare sequence number, counted from
   * `MAX(seq)` over live rows. So the restored box counts from below every
   * phone's cursor, every channel looks like "nothing new", and the crew hear
   * nothing at all until the counter climbs past a number none of them can
   * see. The runbook promises phones "reconnect on their own and stay signed
   * in". They did.
   */
  it('drops the cache when the box says it is a different database', () => {
    expect(databaseChanged('epoch-from-friday', 'epoch-from-the-spare')).toBe(true)
  })

  it('keeps it when the box is the one it was', () => {
    // Which is every ordinary reconnect — an access-point roam, a pocketed
    // phone, a box restart. Dropping a cache there would be a blank screen
    // and a re-download over festival Wi-Fi for nothing.
    expect(databaseChanged('epoch-from-friday', 'epoch-from-friday')).toBe(false)
  })

  it('keeps it on a first connection, having nothing to compare', () => {
    expect(databaseChanged(null, 'epoch-from-friday')).toBe(false)
  })

  it('keeps it against a box too old to say', () => {
    // The field is optional, so a box that predates it simply sends none.
    // That is not evidence of a change.
    expect(databaseChanged('epoch-from-friday', undefined)).toBe(false)
    expect(databaseChanged(null, undefined)).toBe(false)
  })
})
