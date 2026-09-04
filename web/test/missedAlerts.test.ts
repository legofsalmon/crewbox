import { describe, expect, it } from 'vitest'
import { summariseMissed } from '../src/lib/alerts.ts'

/**
 * The DMs a phone comes back to.
 *
 * The chirp lived only on the live `msg` path, so it fired for a message
 * that arrived while the socket was up and for nothing else. Anything that
 * landed during an access-point roam, a box restart or a spell with the tab
 * backgrounded came back in the welcome's `missed` batch and went in
 * silently — which on a festival site is not an edge case. A phone walking
 * between stages roams, a box updating restarts, and a locked phone
 * backgrounds the tab, so the alert that exists to say "somebody needs you"
 * was missing exactly when somebody had been trying for a while.
 */

const CHANNELS = {
  general: { kind: 'public', name: 'general' },
  'stage-2': { kind: 'public', name: 'stage-2' },
  'dm-sam': { kind: 'dm', name: 'Sam' },
  'dm-alex': { kind: 'dm', name: 'Alex' },
}

const USERS = { sam: { name: 'Sam' }, alex: { name: 'Alex' }, me: { name: 'Jo' } }

const base = {
  myId: 'me',
  myName: 'Jo',
  channels: CHANNELS,
  users: USERS,
  readState: {} as Record<string, number>,
}

const message = (over: {
  channelId: string
  seq: number
  authorId?: string | null
  body?: string
}) => ({ body: 'anything', ...over })

describe('what a reconnect should announce', () => {
  it('says nothing when nothing arrived', () => {
    expect(summariseMissed({ ...base, missed: [] })).toBeNull()
  })

  it('says nothing about ordinary channel traffic', () => {
    // The rule is unchanged from the live path: a busy #general is not an
    // interruption, which is the whole reason the chirp is for DMs and
    // mentions only.
    const alert = summariseMissed({
      ...base,
      missed: [message({ channelId: 'general', seq: 1, authorId: 'sam', body: 'radios on' })],
    })
    expect(alert).toBeNull()
  })

  it('reads exactly as it would have live, for a single DM', () => {
    // A roam that dropped one DM should be indistinguishable from not having
    // roamed.
    const alert = summariseMissed({
      ...base,
      missed: [message({ channelId: 'dm-sam', seq: 4, authorId: 'sam', body: 'where are you' })],
    })
    expect(alert).toEqual({ title: 'Sam', body: 'where are you', count: 1 })
  })

  it('names the channel for a single mention', () => {
    const alert = summariseMissed({
      ...base,
      missed: [
        message({ channelId: 'stage-2', seq: 9, authorId: 'alex', body: '@Jo can you look' }),
      ],
    })
    expect(alert).toEqual({ title: 'Alex in #stage-2', body: '@Jo can you look', count: 1 })
  })

  it('is one alert for a backlog, not one per message', () => {
    // Twenty minutes out of signal is not twenty times a reason to chirp. It
    // is a phone somebody puts face-down.
    const alert = summariseMissed({
      ...base,
      missed: [
        message({ channelId: 'dm-sam', seq: 1, authorId: 'sam' }),
        message({ channelId: 'dm-sam', seq: 2, authorId: 'sam' }),
        message({ channelId: 'stage-2', seq: 3, authorId: 'alex', body: '@Jo now please' }),
      ],
    })
    expect(alert).toMatchObject({ title: '3 messages need you', count: 3 })
    expect(alert?.body).toBe('Sam, Alex in #stage-2')
  })

  it('names who, because a count alone is only a reason to open the app', () => {
    const alert = summariseMissed({
      ...base,
      channels: { ...CHANNELS, 'dm-b': { kind: 'dm', name: 'B' } },
      users: { ...USERS, b: { name: 'B' } },
      missed: [
        message({ channelId: 'dm-sam', seq: 1, authorId: 'sam' }),
        message({ channelId: 'dm-alex', seq: 1, authorId: 'alex' }),
        message({ channelId: 'dm-b', seq: 1, authorId: 'b' }),
        message({ channelId: 'stage-2', seq: 4, authorId: 'alex', body: '@all gather' }),
      ],
    })
    expect(alert?.body).toBe('Sam, Alex, B and 1 more')
  })

  it('stays quiet about messages this phone has already read', () => {
    // The replay starts from a cursor, not from what this device has seen, so
    // it carries messages read here before the drop. Announcing those would
    // be a lie.
    const alert = summariseMissed({
      ...base,
      readState: { 'dm-sam': 4 },
      missed: [message({ channelId: 'dm-sam', seq: 4, authorId: 'sam' })],
    })
    expect(alert).toBeNull()
  })

  it('still announces the unread ones alongside read ones', () => {
    const alert = summariseMissed({
      ...base,
      readState: { 'dm-sam': 4 },
      missed: [
        message({ channelId: 'dm-sam', seq: 4, authorId: 'sam', body: 'seen this' }),
        message({ channelId: 'dm-sam', seq: 5, authorId: 'sam', body: 'not this' }),
      ],
    })
    expect(alert).toEqual({ title: 'Sam', body: 'not this', count: 1 })
  })

  it('never announces your own messages', () => {
    // They come back in the replay like anything else.
    const alert = summariseMissed({
      ...base,
      missed: [message({ channelId: 'dm-sam', seq: 2, authorId: 'me', body: '@Jo note to self' })],
    })
    expect(alert).toBeNull()
  })

  it('ignores messages with no author at all', () => {
    expect(
      summariseMissed({
        ...base,
        missed: [message({ channelId: 'dm-sam', seq: 2, authorId: null })],
      })
    ).toBeNull()
  })

  it('stays quiet about the channel already on screen', () => {
    // Same rule as live: you are looking at it.
    const alert = summariseMissed({
      ...base,
      focusedChannelId: 'dm-sam',
      missed: [message({ channelId: 'dm-sam', seq: 2, authorId: 'sam' })],
    })
    expect(alert).toBeNull()
  })

  it('still announces another channel while one is focused', () => {
    const alert = summariseMissed({
      ...base,
      focusedChannelId: 'general',
      missed: [message({ channelId: 'dm-sam', seq: 2, authorId: 'sam', body: 'gate 3' })],
    })
    expect(alert).toEqual({ title: 'Sam', body: 'gate 3', count: 1 })
  })

  it('falls back rather than inventing a name it does not have', () => {
    // A user or channel the snapshot has not caught up with yet.
    const alert = summariseMissed({
      ...base,
      missed: [message({ channelId: 'dm-sam', seq: 2, authorId: 'ghost', body: 'hello' })],
    })
    expect(alert).toEqual({ title: 'Someone', body: 'hello', count: 1 })
  })
})
