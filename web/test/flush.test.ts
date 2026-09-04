import { describe, expect, it } from 'vitest'
import { OUTBOX_FLUSH_GAP_MS, SEND_LIMIT, SEND_WINDOW_MS } from '@crewbox/shared'
import { flushDurationMs, flushOrder, shouldDrop } from '../src/lib/flush.ts'
import type { OutboxEntry } from '../src/lib/db.ts'
import type { QueuedIncident } from '../src/modules/incident/model/outbox.ts'

/**
 * The messages a crew member typed in a dead spot.
 *
 * The box's flood guard refuses more than thirty frames from one socket in
 * ten seconds. That is implausibly fast for a human and instant for a phone
 * flushing an outbox — so thirty-five queued messages meant five refused, and
 * the client deleted every rejection from IndexedDB. They were gone, on the
 * screen that had promised "Nothing is lost while this lasts".
 */

const message = (n: number): OutboxEntry =>
  ({
    clientMsgId: `msg-${n}`,
    channelId: 'general',
    body: `queued ${n}`,
    at: 1_700_000_000_000 + n,
  }) as OutboxEntry

const incident = (n: number): QueuedIncident =>
  ({
    clientMsgId: `inc-${n}`,
    kind: 'note',
    severity: 'info',
    body: `logged ${n}`,
    at: 1_700_000_000_000 + n,
    stage: 'Main',
    actId: '',
    actName: '',
  }) as QueuedIncident

describe('what goes out when the signal comes back', () => {
  it('sends both queues down one sequence', () => {
    // They are stored apart and they share a socket. Pacing them separately
    // would put them over the guard together, which is the bug in miniature.
    const frames = flushOrder([message(1), message(2)], [incident(1)])
    expect(frames.map((f) => f.type)).toEqual(['send', 'send', 'logIncident'])
  })

  it('puts messages before log entries', () => {
    // Somebody is watching a message for a tick. A show-log entry is written
    // to be found later.
    const frames = flushOrder([message(1)], [incident(1), incident(2)])
    expect(frames[0]).toMatchObject({ type: 'send', clientMsgId: 'msg-1' })
  })

  it('carries everything the box needs to dedupe', () => {
    // Re-sending one the box already has is free, but only because the id
    // goes with it.
    const [frame] = flushOrder([message(7)], [])
    expect(frame).toEqual({
      type: 'send',
      clientMsgId: 'msg-7',
      channelId: 'general',
      body: 'queued 7',
      fileId: undefined,
    })
  })

  it('is empty when there is nothing queued', () => {
    expect(flushOrder([], [])).toEqual([])
    expect(flushDurationMs(0)).toBe(0)
  })

  it('paces a full outbox under the guard, with room for live typing', () => {
    // The number that matters: a window's worth of replay has to fit inside
    // the allowance and leave some, because the crew member whose phone is
    // catching up is very often typing while it does.
    const inOneWindow = Math.floor(SEND_WINDOW_MS / OUTBOX_FLUSH_GAP_MS)
    expect(inOneWindow).toBeLessThan(SEND_LIMIT)
    expect(SEND_LIMIT - inOneWindow).toBeGreaterThanOrEqual(10)
  })

  it('takes a bounded, sayable time for a realistic backlog', () => {
    // Thirty-five is the number from the report. Seventeen seconds to catch
    // up is a reconnect; losing five messages is not.
    expect(flushDurationMs(35)).toBe(34 * OUTBOX_FLUSH_GAP_MS)
    expect(flushDurationMs(35)).toBeLessThan(30_000)
  })

  it('sends a single queued message with no delay at all', () => {
    expect(flushDurationMs(1)).toBe(0)
  })
})

describe('what a rejection means', () => {
  it('keeps what the box only refused for now', () => {
    // The whole fix. `retry` is the flood guard saying "not now", which is
    // not a judgement about the message.
    expect(
      shouldDrop({
        type: 'rejected',
        clientMsgId: 'msg-31',
        reason: 'slow down — too many messages',
        retry: true,
      })
    ).toBe(false)
  })

  it('drops what will never be accepted', () => {
    // Facts about the message: waiting changes none of them, and keeping
    // them queued for ever would be worse than saying so.
    for (const reason of ['channel not found', 'channel retired', 'empty message']) {
      expect(shouldDrop({ type: 'rejected', clientMsgId: 'msg-1', reason })).toBe(true)
    }
  })
})
