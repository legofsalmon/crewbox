// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { INCIDENT_CLOCK_SLACK_MS, type Channel } from '@crewbox/shared'
import type { OutboxEntry } from './db.ts'
import type { KnownEvent } from './eventScope.ts'
import {
  carriedHere,
  hasWork,
  movedCopy,
  offerCopy,
  placeUnsent,
  settledBy,
  stillFiled,
  toOffer,
  type MoveResult,
} from './moveWork.ts'

/**
 * Bringing an event's work to the box that took its place: where each thing
 * goes, when to ask, and what is said. The move itself reads and writes a
 * real browser's IndexedDB, and is exercised in e2e/boxes.spec.ts.
 */

const channel = (id: string, name: string, fields: Partial<Channel> = {}): Channel => ({
  id,
  name,
  kind: 'public',
  topic: '',
  lastSeq: 0,
  createdAt: 0,
  ...fields,
})

const unsent = (clientMsgId: string, channelId: string, fields: Partial<OutboxEntry> = {}) => ({
  clientMsgId,
  channelId,
  body: `message ${clientMsgId}`,
  createdAt: 1,
  ...fields,
})

describe('where an unsent message goes on the box taking over', () => {
  // The old box's channels, and the new box's: the same names, IDs of its own.
  const theirs = [
    channel('old-general', 'general'),
    channel('old-stage', 'stage'),
    channel('old-rigging', 'rigging'),
    channel('old-dm', 'dm', { kind: 'dm', memberIds: ['u1', 'u2'] }),
  ]
  const ours = [channel('new-general', 'general'), channel('new-stage', 'stage')]

  it('goes to the channel with the same name, as it was written', () => {
    const { moving, staying } = placeUnsent(
      [unsent('a', 'old-general'), unsent('b', 'old-stage')],
      theirs,
      ours
    )
    expect(moving).toEqual([
      { clientMsgId: 'a', channelId: 'new-general', body: 'message a', createdAt: 1 },
      { clientMsgId: 'b', channelId: 'new-stage', body: 'message b', createdAt: 1 },
    ])
    expect(staying).toEqual([])
  })

  it('stays behind, saying why, where it cannot go', () => {
    const { moving, staying } = placeUnsent(
      [
        // A channel this box does not have yet.
        unsent('a', 'old-rigging'),
        // A person, who has a new account on this box.
        unsent('b', 'old-dm'),
        // A file, which is on the old box.
        unsent('c', 'old-general', { fileId: 'f1', fileName: 'plot.pdf' }),
        // A channel the old box's snapshot never listed.
        unsent('d', 'old-unknown'),
      ],
      theirs,
      ours
    )
    expect(moving).toEqual([])
    expect(staying).toEqual(['channel', 'person', 'file', 'channel'])
  })

  it('never goes to a retired channel, or to a person who shares its name', () => {
    const { staying } = placeUnsent(
      [unsent('a', 'old-stage'), unsent('b', 'old-rigging')],
      theirs,
      [
        channel('new-stage', 'stage', { retired: true }),
        channel('new-dm', 'rigging', { kind: 'dm' }),
      ]
    )
    expect(staying).toEqual(['channel', 'channel'])
  })
})

const event = (fields: Partial<KnownEvent> & { id: string }): KnownEvent => ({
  name: '',
  origin: 'http://10.0.0.2',
  seenAt: 1,
  ...fields,
})

describe('when to ask', () => {
  it('asks about an event the open event’s box says it carries on, until answered', () => {
    const friday = event({ id: 'friday', replacedBy: 'spare', continuedBy: 'spare' })
    expect(toOffer([friday], 'spare')).toBe(friday)
    expect(toOffer([{ ...friday, moveAnswered: true }], 'spare')).toBeUndefined()
    // Not from any other event, or with none open.
    expect(toOffer([friday], 'saturday')).toBeUndefined()
    expect(toOffer([friday], null)).toBeUndefined()
  })

  it('doesn’t ask on a guess from the address alone', () => {
    // A new database where the event's box was is as likely next week's
    // event as a spare: Your boxes offers the move, and nothing asks.
    const friday = event({ id: 'friday', replacedBy: 'spare' })
    expect(toOffer([friday], 'spare')).toBeUndefined()
    // Nor when it was another box that said it carries the event on.
    expect(toOffer([{ ...friday, continuedBy: 'bigger-box' }], 'spare')).toBeUndefined()
  })

  it('asks about the latest first, where two came back as it', () => {
    const older = event({ id: 'friday', replacedBy: 'spare', continuedBy: 'spare', seenAt: 1 })
    const newer = event({ id: 'thursday', replacedBy: 'spare', continuedBy: 'spare', seenAt: 2 })
    expect(toOffer([older, newer], 'spare')).toBe(newer)
  })

  it('knows a box its admin says carries an event on from one standing where its box stood', () => {
    expect(carriedHere(event({ id: 'friday', replacedBy: 'spare', continuedBy: 'spare' }))).toBe(
      true
    )
    expect(carriedHere(event({ id: 'friday', replacedBy: 'spare' }))).toBe(false)
    expect(carriedHere(event({ id: 'friday', replacedBy: 'spare', continuedBy: 'other' }))).toBe(
      false
    )
    // Everything came, and only the word is left.
    expect(carriedHere(event({ id: 'friday', continuedBy: 'spare' }))).toBe(false)
  })

  it('has something to ask about only when the device holds some of its work', () => {
    const none = { documents: 0, acts: 0, unsentMessages: 0, unsentEntries: 0 }
    expect(hasWork(none)).toBe(false)
    expect(hasWork({ ...none, acts: 3 })).toBe(true)
    expect(hasWork({ ...none, unsentEntries: 1 })).toBe(true)
  })
})

describe('what the question says', () => {
  const held = { documents: 6, acts: 12, unsentMessages: 2, unsentEntries: 1 }

  it('lists what this phone has, from which event', () => {
    expect(offerCopy(event({ id: 'friday', name: 'Harbour Fest' }), held)).toEqual({
      lede: 'This phone still has work from Harbour Fest, from before this box started afresh:',
      items: [
        '6 shared documents',
        'the running order',
        '2 unsent messages',
        '1 unsent show-log entry',
      ],
    })
  })

  it('reads without a name, and lists only what there is', () => {
    const copy = offerCopy(event({ id: 'friday', name: ' ' }), {
      documents: 1,
      acts: 0,
      unsentMessages: 1,
      unsentEntries: 0,
    })
    expect(copy.lede).toBe('This phone still has work from before this box started afresh:')
    expect(copy.items).toEqual(['1 shared document', '1 unsent message'])
  })

  it('says the box carries the event on, where its admin said so', () => {
    const carried = { replacedBy: 'spare', continuedBy: 'spare' }
    expect(offerCopy(event({ id: 'friday', name: 'Harbour Fest', ...carried }), held).lede).toBe(
      'This box carries on Harbour Fest, and this phone still has work from it:'
    )
    expect(offerCopy(event({ id: 'friday', name: '', ...carried }), held).lede).toBe(
      'This box carries on an event this phone still has work from:'
    )
  })
})

const result = (fields: Partial<MoveResult>): MoveResult => ({
  documents: 0,
  documentsLeft: 0,
  runningOrder: 'none',
  messages: 0,
  staying: [],
  entries: 0,
  entriesLeft: 0,
  entriesTooOld: 0,
  ...fields,
})

describe('what a move says it did', () => {
  it('says what came', () => {
    expect(
      movedCopy(result({ documents: 6, runningOrder: 'moved', messages: 2, entries: 1 }))
    ).toEqual({
      heading: 'Brought across',
      lines: ['Brought here: 6 documents, the running order, 2 messages and 1 show-log entry.'],
    })
  })

  it('says what stayed behind, and why', () => {
    const { heading, lines } = movedCopy(
      result({
        messages: 1,
        runningOrder: 'kept',
        staying: ['channel', 'channel', 'person', 'file'],
      })
    )
    expect(heading).toBe('Brought across')
    expect(lines).toEqual([
      'Brought here: 1 message.',
      'The running order stayed behind: this box has one of its own.',
      '2 messages stayed behind: their channels are not on this box yet. Once an admin makes them, bring them across from Your boxes.',
      '1 message to a person stayed behind: everyone has a new account on this box.',
      '1 message with a file stayed behind: the file is on the old box.',
    ])
  })

  it('says why an entry too old for any box stayed behind', () => {
    expect(movedCopy(result({ entries: 1, entriesTooOld: 2 })).lines).toEqual([
      'Brought here: 1 show-log entry.',
      '2 show-log entries stayed behind: a box only files entries written in the last day.',
    ])
  })

  it('says to try again when something could not be saved here', () => {
    expect(movedCopy(result({ runningOrder: 'unchecked' }))).toEqual({
      heading: 'Nothing brought across',
      lines: ['Some of it stayed behind for now. Try again from Your boxes.'],
    })
  })
})

describe('whether a move leaves anything to try again', () => {
  it('is done when all came, or what stayed never can', () => {
    expect(settledBy(result({ documents: 2, messages: 1 }))).toBe(true)
    expect(settledBy(result({ runningOrder: 'kept', staying: ['person', 'file'] }))).toBe(true)
    expect(settledBy(result({ entriesTooOld: 1 }))).toBe(true)
  })

  it('is not while a message waits for its channel, or something was not saved', () => {
    expect(settledBy(result({ staying: ['channel'] }))).toBe(false)
    expect(settledBy(result({ staying: ['unsaved'] }))).toBe(false)
    expect(settledBy(result({ documentsLeft: 1 }))).toBe(false)
    expect(settledBy(result({ entriesLeft: 1 }))).toBe(false)
    expect(settledBy(result({ runningOrder: 'unchecked' }))).toBe(false)
  })
})

describe('which show-log entries a box would still file', () => {
  const now = Date.UTC(2026, 8, 24, 12)

  it('moves one written today, or a little ahead of this clock', () => {
    expect(stillFiled(now - 60_000, now)).toBe(true)
    expect(stillFiled(now - 20 * 60 * 60_000, now)).toBe(true)
    expect(stillFiled(now + 5 * 60_000, now)).toBe(true)
  })

  it('leaves one the box would refuse, and one it would refuse by the time it went', () => {
    expect(stillFiled(now - INCIDENT_CLOCK_SLACK_MS - 1, now)).toBe(false)
    expect(stillFiled(now - INCIDENT_CLOCK_SLACK_MS + 60_000, now)).toBe(false)
    expect(stillFiled(now - 2 * INCIDENT_CLOCK_SLACK_MS, now)).toBe(false)
    expect(stillFiled(now + INCIDENT_CLOCK_SLACK_MS, now)).toBe(false)
  })
})
