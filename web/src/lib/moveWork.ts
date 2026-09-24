import { INCIDENT_CLOCK_SLACK_MS, type Channel } from '@crewbox/shared'
import { useStore } from '../store.ts'
import { databaseNames, holdingsOf, list, plural, type Holdings } from './boxes.ts'
import { chatDatabase, chatDatabaseName, type OutboxEntry } from './db.ts'
import { allDocStores } from './docs/store.ts'
import { answerMove, type KnownEvent } from './eventScope.ts'
import { queuedIncidentsOf, unqueueIncidentsOf } from '../modules/incident/model/outbox.ts'
import {
  moveRunningOrderFrom,
  runningOrderActsOf,
  type RunningOrderMove,
} from '../shell/timetable/store.ts'

/**
 * Bringing an event's work to the box that took its place (finding 16).
 *
 * A spare box with a fresh database, put where the event's box was, knows
 * nothing of the event: its channels have IDs of their own, and it has none
 * of the documents. A phone keeps the old event's work apart
 * (lib/eventScope.ts), and once it has joined the new box it is asked, once,
 * whether to bring that work across. Documents and the running order merge
 * the way phones' copies always merge, unsent messages go to the channels
 * with the same names, and unsent show-log entries to the new box's log. The
 * old chat stays on the phone to read.
 *
 * Nothing tells a phone whether the new box carries on the same event or
 * starts another, which is for an admin to say in a later phase. So it is a
 * question, and "Not now" leaves everything where it was.
 */

/** What a device holds for an event that could be brought across. */
export interface Movable extends Holdings {
  /** Acts in its running order. */
  acts: number
}

export async function movableOf(event: string): Promise<Movable> {
  const [holdings, acts] = await Promise.all([holdingsOf(event), runningOrderActsOf(event)])
  return { ...holdings, acts }
}

export const hasWork = (held: Movable): boolean =>
  held.documents + held.acts + held.unsentMessages + held.unsentEntries > 0

/**
 * The event to ask about, if any: one whose box came back as the open one,
 * and not asked about yet. The latest first, where there are several.
 */
export function toOffer(
  events: readonly KnownEvent[],
  open: string | null
): KnownEvent | undefined {
  if (!open) return undefined
  return events
    .filter((event) => event.replacedBy === open && !event.moveAnswered)
    .sort((a, b) => b.seenAt - a.seenAt)[0]
}

/** Why an unsent message stayed behind. */
export type Staying = 'person' | 'file' | 'channel' | 'unsaved'

/**
 * Where each of an event's unsent messages goes on the box taking over.
 *
 * To the channel with the same name, whose ID a box with a fresh database
 * minted itself: `general` is on every box, and the rest once an admin makes
 * them. A message to a person stays, because people on a new box have new
 * accounts, and so does one with a file, which is on the old box.
 */
export function placeUnsent(
  outbox: readonly OutboxEntry[],
  theirs: readonly Channel[],
  ours: readonly Channel[]
): { moving: OutboxEntry[]; staying: Staying[] } {
  const named = new Map(
    ours.filter((c) => c.kind !== 'dm' && !c.retired).map((c) => [c.name, c.id] as const)
  )
  const was = new Map(theirs.map((c) => [c.id, c] as const))
  const moving: OutboxEntry[] = []
  const staying: Staying[] = []
  for (const entry of outbox) {
    const channel = was.get(entry.channelId)
    const to = channel ? named.get(channel.name) : undefined
    if (channel?.kind === 'dm') staying.push('person')
    else if (entry.fileId) staying.push('file')
    else if (to) moving.push({ ...entry, channelId: to })
    else staying.push('channel')
  }
  return { moving, staying }
}

/** An event's unsent messages, and its channels as its box last said them. */
async function readUnsent(event: string): Promise<{ outbox: OutboxEntry[]; channels: Channel[] }> {
  const names = await databaseNames()
  if (names && !names.includes(chatDatabaseName(event))) return { outbox: [], channels: [] }
  const db = chatDatabase(event)
  try {
    const [outbox, snapshot] = await Promise.all([
      db.outbox.orderBy('createdAt').toArray(),
      db.kv.get('snapshot'),
    ])
    return { outbox, channels: snapshot?.channels ?? [] }
  } catch {
    return { outbox: [], channels: [] }
  } finally {
    db.close()
  }
}

/**
 * Whether a box would still file a show-log entry written at `at`.
 *
 * A box takes entries from within a day of its own clock and turns the rest
 * away for good, and a phone deletes an entry once it has been turned away.
 * So one written more than a day ago stays with its own event rather than
 * being moved to be refused. This device's clock stands in for the box's,
 * short of the limit by enough for the two to differ by minutes and for the
 * entry to go out a little after it moves.
 */
export const stillFiled = (at: number, now = Date.now()): boolean =>
  Math.abs(now - at) <= INCIDENT_CLOCK_SLACK_MS - 15 * 60_000

async function dropUnsent(event: string, clientMsgIds: string[]): Promise<void> {
  if (!clientMsgIds.length) return
  const db = chatDatabase(event)
  try {
    await db.outbox.bulkDelete(clientMsgIds)
  } catch {
    // Still queued there, and the box deduplicates: at worst sent twice.
  } finally {
    db.close()
  }
}

/** What a move did. */
export interface MoveResult {
  /** Documents merged here and gone from the other event. */
  documents: number
  /** Documents this device could not show had been saved here. */
  documentsLeft: number
  runningOrder: RunningOrderMove
  /** Unsent messages queued here, and going to this box. */
  messages: number
  /** Why each of the other unsent messages stayed behind. */
  staying: Staying[]
  /** Unsent show-log entries queued here. */
  entries: number
  entriesLeft: number
  /** Unsent show-log entries no box would file now, left with their event. */
  entriesTooOld: number
}

/**
 * Whether a move left nothing a later one could bring: what stayed behind
 * can never come here, or nothing did. An entry too old to file now never
 * will be.
 */
export const settledBy = (result: MoveResult): boolean =>
  result.documentsLeft === 0 &&
  result.entriesLeft === 0 &&
  result.runningOrder !== 'unchecked' &&
  result.staying.every((reason) => reason === 'person' || reason === 'file')

/**
 * Bring an event's work to the open event, and answer the offer.
 *
 * Every part of it can be done again: a document or running order already
 * brought merges into itself, and whatever moved has gone from the other
 * event. So a move that left something behind can be tried again from the
 * event's row, once whatever held it up has changed.
 */
export async function moveWork(from: string): Promise<MoveResult> {
  let documents = 0
  let documentsLeft = 0
  for (const store of allDocStores()) {
    const { moved, left } = await store.moveFrom(from)
    documents += moved
    documentsLeft += left
  }
  const runningOrder = await moveRunningOrderFrom(from)

  const { channels, queueMoved } = useStore.getState()
  const unsent = await readUnsent(from)
  const { moving, staying } = placeUnsent(unsent.outbox, unsent.channels, Object.values(channels))
  const queued = queuedIncidentsOf(from)
  const entries = queued.filter((entry) => stillFiled(entry.at))
  const saved = await queueMoved(moving, entries)
  const sent = moving.filter((entry) => saved.has(entry.clientMsgId))
  await dropUnsent(
    from,
    sent.map((entry) => entry.clientMsgId)
  )
  unqueueIncidentsOf(from, saved)
  const entriesMoved = entries.filter((entry) => saved.has(entry.clientMsgId)).length

  const result: MoveResult = {
    documents,
    documentsLeft,
    runningOrder,
    messages: sent.length,
    staying: [...staying, ...Array<Staying>(moving.length - sent.length).fill('unsaved')],
    entries: entriesMoved,
    entriesLeft: entries.length - entriesMoved,
    entriesTooOld: queued.length - entries.length,
  }
  answerMove(from, settledBy(result))
  return result
}

/** The offer: what this device holds, from which event. */
export function offerCopy(from: KnownEvent, held: Movable): { lede: string; items: string[] } {
  const name = from.name.trim()
  return {
    lede: name
      ? `This phone still has work from ${name}, from before this box started afresh:`
      : 'This phone still has work from before this box started afresh:',
    items: [
      ...(held.documents ? [plural(held.documents, 'shared document', 'shared documents')] : []),
      ...(held.acts ? ['the running order'] : []),
      ...(held.unsentMessages
        ? [plural(held.unsentMessages, 'unsent message', 'unsent messages')]
        : []),
      ...(held.unsentEntries
        ? [plural(held.unsentEntries, 'unsent show-log entry', 'unsent show-log entries')]
        : []),
    ],
  }
}

/** What a move did, said once it has: what came, and what stayed and why. */
export function movedCopy(result: MoveResult): { heading: string; lines: string[] } {
  const brought = [
    ...(result.documents ? [plural(result.documents, 'document', 'documents')] : []),
    ...(result.runningOrder === 'moved' ? ['the running order'] : []),
    ...(result.messages ? [plural(result.messages, 'message', 'messages')] : []),
    ...(result.entries ? [plural(result.entries, 'show-log entry', 'show-log entries')] : []),
  ]
  const lines = brought.length ? [`Brought here: ${list(brought)}.`] : []
  const count = (reason: Staying) => result.staying.filter((r) => r === reason).length
  if (result.runningOrder === 'kept') {
    lines.push('The running order stayed behind: this box has one of its own.')
  }
  const channel = count('channel')
  if (channel) {
    lines.push(
      channel === 1
        ? '1 message stayed behind: its channel is not on this box yet. Once an admin makes it, bring it across from Your boxes.'
        : `${channel} messages stayed behind: their channels are not on this box yet. Once an admin makes them, bring them across from Your boxes.`
    )
  }
  const person = count('person')
  if (person) {
    lines.push(
      `${plural(person, 'message to a person', 'messages to people')} stayed behind: everyone has a new account on this box.`
    )
  }
  const file = count('file')
  if (file) {
    lines.push(
      `${plural(file, 'message with a file', 'messages with files')} stayed behind: the ${file === 1 ? 'file is' : 'files are'} on the old box.`
    )
  }
  if (result.entriesTooOld) {
    lines.push(
      `${plural(result.entriesTooOld, 'show-log entry', 'show-log entries')} stayed behind: a box only files entries written in the last day.`
    )
  }
  if (
    result.runningOrder === 'unchecked' ||
    result.documentsLeft ||
    result.entriesLeft ||
    count('unsaved')
  ) {
    lines.push('Some of it stayed behind for now. Try again from Your boxes.')
  }
  return { heading: brought.length ? 'Brought across' : 'Nothing brought across', lines }
}
