import type { Message } from '@crewbox/shared'
import { describe, expect, it } from 'vitest'
import { capTranscript } from './transcript.ts'

/**
 * How much of a channel stays in memory once nobody is looking at it.
 *
 * The 300-per-channel cap was only ever the cache's. The in-memory array —
 * and the DOM row `MessageList` renders for every entry in it — grew for the
 * whole shift, so a phone with #general open through a festival Saturday
 * held thousands of message objects and as many rows, on a device chosen for
 * being cheap enough to lose.
 */

const msg = (seq: number): Message =>
  ({
    id: `m${seq}`,
    channelId: 'general',
    authorId: 'u1',
    body: `message ${seq}`,
    createdAt: seq,
    seq,
    kind: 'text',
  }) as Message

const run = (n: number) => Array.from({ length: n }, (_, i) => msg(i + 1))

describe('capping a channel transcript', () => {
  it('keeps the newest, because that is the end people are reading from', () => {
    const capped = capTranscript(run(10), 4)
    expect(capped.map((m) => m.seq)).toEqual([7, 8, 9, 10])
  })

  it('leaves a short channel completely alone, identity included', () => {
    // Identity matters: this runs inside `ingestMessages`, and handing back
    // a new array for every channel on every message would defeat the point
    // by re-rendering them all.
    const held = run(3)
    expect(capTranscript(held, 4)).toBe(held)
    expect(capTranscript([], 4)).toEqual([])
  })

  it('leaves it alone at exactly the cap', () => {
    const held = run(4)
    expect(capTranscript(held, 4)).toBe(held)
  })

  it('is a tail, so the order the reader sees never changes', () => {
    const capped = capTranscript(run(1000), 500)
    expect(capped).toHaveLength(500)
    expect(capped[0]!.seq).toBe(501)
    expect(capped.at(-1)!.seq).toBe(1000)
    expect(capped.every((m, i) => i === 0 || m.seq > capped[i - 1]!.seq)).toBe(true)
  })
})
