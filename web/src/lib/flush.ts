import { OUTBOX_FLUSH_GAP_MS, type ClientMessage, type RejectedMessage } from '@crewbox/shared'
import type { OutboxEntry } from './db.ts'
import type { QueuedIncident } from '../modules/incident/model/outbox.ts'

/**
 * What a phone sends when it gets its signal back.
 *
 * Two queues arrive here: chat messages from IndexedDB, and show-log entries
 * from localStorage. They are stored separately because they have to survive
 * different things — a log entry outlives the phone giving up and reloading —
 * but on the wire they are one socket and one allowance, and forgetting that
 * is what broke this.
 *
 * The box's flood guard counts frames per connection: thirty in ten seconds,
 * implausibly fast for a human and instant for a phone flushing an outbox. A
 * crew member who typed thirty-five messages in a dead spot had five refused
 * on reconnect — and the client, treating every rejection as final, deleted
 * them from IndexedDB. The screen at the time said "Nothing is lost while
 * this lasts".
 *
 * Both halves are fixed here: the replay is paced under the guard, and a
 * rejection carrying `retry` is kept rather than dropped.
 */

/**
 * Everything queued, as one sequence of frames.
 *
 * One sequence rather than two loops, because the two queues share the
 * socket's allowance and pacing them separately would put them over it
 * together — which is exactly the bug, in miniature. Messages first: they are
 * what somebody is watching for a tick against, and a show-log entry is
 * written to be found later.
 */
export function flushOrder(
  outbox: readonly OutboxEntry[],
  incidents: readonly QueuedIncident[]
): ClientMessage[] {
  return [
    ...outbox.map((entry): ClientMessage => ({
      type: 'send',
      clientMsgId: entry.clientMsgId,
      channelId: entry.channelId,
      body: entry.body,
      fileId: entry.fileId,
    })),
    ...incidents.map((entry): ClientMessage => ({ type: 'logIncident', ...entry })),
  ]
}

/** How long a paced flush of this many frames takes, end to end. */
export function flushDurationMs(frames: number): number {
  return frames <= 1 ? 0 : (frames - 1) * OUTBOX_FLUSH_GAP_MS
}

/**
 * Should this rejection take the entry out of the queue?
 *
 * Everything except the flood guard is a fact about the message — too long,
 * no such channel, a channel that has been retired — and no amount of waiting
 * changes any of them, so those are dropped and said out loud. `retry` is the
 * box saying "not now", which is not the same thing and must not be treated
 * as one.
 */
export function shouldDrop(msg: RejectedMessage): boolean {
  return !msg.retry
}
