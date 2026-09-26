import { createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  callAlert,
  callsDue,
  callsFor,
  countdownFor,
  incidentAlert,
  incidentAlerts,
  isMentioned,
  levelFor,
  messageAlert,
  messageAlertKind,
  movedCalls,
  shapeCatchUp,
  zonedInstant,
  CATCH_UP_LIMIT,
  type Act,
  type Alert,
  type AlertChannelInput,
  type AlertKind,
  type AlertMessageInput,
  type ChannelAlertLevel,
  type Incident,
} from '@crewbox/shared'
// @ts-expect-error -- a plain .mjs script with no types, run by hand
import { FIXTURES, render } from '../../scripts/alerts-fixtures.mjs'
import { identityStatement } from '../src/identity.ts'

/**
 * The alerts contract (shared/src/alerts.ts): what buzzes a phone, decided
 * once on the box.
 *
 * The rule cases and the frames live in alerts-fixtures.json, which the
 * Android app's tests read too, so a case written once holds the box and the
 * phone to the same answer.
 */

interface Fixtures {
  mentions: { body: string; name: string; expect: boolean }[]
  messages: {
    name: string
    message: AlertMessageInput
    channel: AlertChannelInput
    person: { id: string; name: string }
    level: ChannelAlertLevel
    readSeq: number
    expect: AlertKind | null
  }[]
  incidents: { name: string; incident: Incident; expect: boolean }[]
  calls: {
    name: string
    acts: Act[]
    day: string
    expect: { id: string; due: number; title: string }[]
  }[]
  signed: {
    key: string
    eventId: string
    host: string
    nonce: string
    statement: string
    signature: string
    wrongHost: string
  }
  alertInputs: {
    mention: MessageInput
    dm: MessageInput
    desk: MessageInput
    showStop: { incident: Incident; quiet: boolean }
    changeover: { acts: Act[]; day: string; id: string; at: number; quiet: boolean }
  }
  frames: Record<string, { type: string; t?: number; alert?: Alert } & Record<string, unknown>>
}

interface MessageInput {
  message: AlertMessageInput
  channel: AlertChannelInput
  kind: AlertKind
  authorName: string
  quiet: boolean
}

const file = readFileSync(FIXTURES as string, 'utf8')
const fixtures = JSON.parse(file) as Fixtures

describe('the alerts fixtures', () => {
  it('are what scripts/alerts-fixtures.mjs writes', () => {
    // Run `node scripts/alerts-fixtures.mjs` after changing a case.
    expect(file).toBe((render as () => string)())
  })
})

describe('mentions', () => {
  for (const c of fixtures.mentions) {
    it(`${JSON.stringify(c.body)} for ${JSON.stringify(c.name)}`, () => {
      expect(isMentioned(c.body, c.name)).toBe(c.expect)
    })
  }
})

describe('what a message is to somebody', () => {
  for (const c of fixtures.messages) {
    it(c.name, () => {
      expect(
        messageAlertKind({
          message: c.message,
          channel: c.channel,
          person: c.person,
          level: c.level,
          readSeq: c.readSeq,
        })
      ).toBe(c.expect)
    })
  }

  it('starts every channel at Mentions', () => {
    expect(levelFor({ channels: {}, stages: [] }, 'c-any')).toBe('mentions')
    expect(levelFor({ channels: { 'c-any': 'all' }, stages: [] }, 'c-any')).toBe('all')
  })

  it('says a file for a message with no words', () => {
    const alert = messageAlert({
      message: {
        id: 'm',
        channelId: 'c',
        seq: 1,
        authorId: 'u',
        kind: 'file',
        body: '',
        file: { name: 'patch.pdf' },
        createdAt: 1,
      },
      channel: { id: 'c', name: 'foh', kind: 'public' },
      kind: 'message',
      authorName: 'Jo',
      quiet: false,
    })
    expect(alert.body).toBe('📎 patch.pdf')
  })
})

describe('the show log', () => {
  for (const c of fixtures.incidents) {
    it(c.name, () => {
      expect(incidentAlerts(c.incident)).toBe(c.expect)
    })
  }
})

describe('changeover calls', () => {
  for (const c of fixtures.calls) {
    it(c.name, () => {
      const got = callsFor(c.acts, c.day).map(({ id, due, title }) => ({ id, due, title }))
      expect(got).toEqual(c.expect)
    })
  }

  it('fires each call once, in the window it falls in', () => {
    const calls = callsFor(fixtures.calls[0]!.acts, '2026-07-10')
    expect(callsDue(calls, 1194, 1195).map((c) => c.call)).toEqual(['soon'])
    expect(callsDue(calls, 1195, 1259)).toEqual([])
    expect(callsDue(calls, 1259, 1260).map((c) => c.call)).toEqual(['changeover'])
  })

  it('calls a set that moves within two hours, and re-arms it', () => {
    const before: Act[] = [
      {
        id: 'a-2',
        name: 'The Hollows',
        stage: 'Main Stage',
        date: '2026-07-10',
        start: '21:30',
        end: '22:30',
        changeover: 0,
      },
    ]
    const after: Act[] = [{ ...before[0]!, start: '21:45', end: '22:45' }]
    const moved = movedCalls(before, after, '2026-07-10', 20 * 60)
    expect(moved.map((c) => [c.id, c.title, c.body, c.urgent])).toEqual([
      [
        'c:a-2:moved:2026-07-10:1305',
        'The Hollows now on at 21:45',
        'Main Stage, was 21:30',
        false,
      ],
    ])
    // A set three hours off is not worth a call yet.
    expect(movedCalls(before, after, '2026-07-10', 18 * 60)).toEqual([])
    // Nothing moved, nothing to say.
    expect(movedCalls(before, before, '2026-07-10', 20 * 60)).toEqual([])
    // Its other calls carry the new start, so they fire again at the new time.
    expect(callsFor(after, '2026-07-10').map((c) => c.id)).toContain('c:a-2:soon:2026-07-10:1305')
  })
})

describe('the countdown', () => {
  const acts: Act[] = [
    {
      id: 'a-1',
      name: 'Night Bus',
      stage: 'Main Stage',
      date: '2026-07-10',
      start: '20:00',
      end: '21:00',
      changeover: 0,
    },
    {
      id: 'a-2',
      name: 'The Hollows',
      stage: 'Main Stage',
      date: '2026-07-10',
      start: '21:30',
      end: '',
      changeover: 0,
    },
    {
      id: 'a-3',
      name: 'Elsewhere',
      stage: 'Tent',
      date: '2026-07-10',
      start: '20:00',
      end: '21:00',
      changeover: 0,
    },
  ]
  // 20:30 in London in July is 19:30 UTC.
  const now = new Date(Date.UTC(2026, 6, 10, 19, 30))

  it('gives only the stages somebody follows', () => {
    expect(countdownFor(acts, [], now, 'Europe/London')).toEqual([])
    expect(countdownFor(acts, ['Main Stage'], now, 'Europe/London').map((s) => s.stage)).toEqual([
      'Main Stage',
    ])
  })

  it("works the instants out in the phone's own zone", () => {
    const [london] = countdownFor(acts, ['Main Stage'], now, 'Europe/London')
    expect(london!.onNow).toEqual({
      actId: 'a-1',
      name: 'Night Bus',
      start: Date.UTC(2026, 6, 10, 19, 0),
      end: Date.UTC(2026, 6, 10, 20, 0),
    })
    expect(london!.next).toEqual({
      actId: 'a-2',
      name: 'The Hollows',
      start: Date.UTC(2026, 6, 10, 20, 30),
      end: null,
    })
    // A phone set to New York reads the same wall-clock sheet in its zone:
    // it is 15:30 there, and 20:00 is four and a half hours off.
    const [newYork] = countdownFor(acts, ['Main Stage'], now, 'America/New_York')
    expect(newYork!.onNow).toBeNull()
    expect(newYork!.next!.start).toBe(Date.UTC(2026, 7 - 1, 11, 0, 0))
  })

  it('places a wall-clock time in a zone, across the 06:00 roll', () => {
    expect(zonedInstant('2026-07-10', 21 * 60, 'Europe/London')).toBe(Date.UTC(2026, 6, 10, 20, 0))
    // 00:30 on the night of the 10th is the 11th's morning.
    expect(zonedInstant('2026-07-10', 24 * 60 + 30, 'Europe/London')).toBe(
      Date.UTC(2026, 6, 10, 23, 30)
    )
    expect(zonedInstant('2026-01-10', 21 * 60, 'Europe/London')).toBe(Date.UTC(2026, 0, 10, 21, 0))
    expect(zonedInstant('not a day', 0, 'Europe/London')).toBeNull()
  })
})

describe('a catch-up', () => {
  const alert = (i: number): Alert => ({
    id: `m:${i}`,
    kind: 'dm',
    title: 't',
    body: 'b',
    target: { kind: 'channel', channelId: 'c' },
    thread: 'c',
    quiet: false,
    urgent: false,
    at: 1000 + i,
  })

  it('sounds once, for the newest', () => {
    const { catchUp, more } = shapeCatchUp([alert(3), alert(1), alert(2)])
    expect(catchUp.map((a) => [a.id, a.quiet])).toEqual([
      ['m:1', true],
      ['m:2', true],
      ['m:3', false],
    ])
    expect(more).toBe(0)
  })

  it('keeps the newest twenty and counts the rest', () => {
    const { catchUp, more } = shapeCatchUp(Array.from({ length: 25 }, (_, i) => alert(i)))
    expect(catchUp).toHaveLength(CATCH_UP_LIMIT)
    expect(catchUp[0]!.id).toBe('m:5')
    expect(more).toBe(5)
  })

  it('keeps alerts from the same millisecond in the order the box stored them', () => {
    // Message ids are random, so ordering by id sounded an older message
    // about half the time (it failed CI once).
    const zed = { ...alert(0), id: 'm:zed', at: 5000 }
    const abe = { ...alert(0), id: 'm:abe', at: 5000 }
    expect(shapeCatchUp([zed, abe]).catchUp.map((a) => [a.id, a.quiet])).toEqual([
      ['m:zed', true],
      ['m:abe', false],
    ])
  })

  it('is empty when nothing was missed', () => {
    expect(shapeCatchUp([])).toEqual({ catchUp: [], more: 0 })
  })
})

describe('the frames', () => {
  const { alertInputs: inputs, frames } = fixtures

  it('carry the alerts the rules build', () => {
    expect(messageAlert(inputs.mention)).toEqual(frames.alertMention!.alert)
    expect(messageAlert(inputs.dm)).toEqual(frames.alertDm!.alert)
    expect(messageAlert(inputs.desk)).toEqual(frames.alertDesk!.alert)
    expect(incidentAlert(inputs.showStop.incident, inputs.showStop.quiet)).toEqual(
      frames.alertShowStop!.alert
    )
    const call = callsFor(inputs.changeover.acts, inputs.changeover.day).find(
      (c) => c.id === inputs.changeover.id
    )!
    expect(callAlert(call, inputs.changeover.at, inputs.changeover.quiet)).toEqual(
      frames.alertChangeover!.alert
    )
  })

  it('stamp every frame from the box with its clock', () => {
    for (const [name, frame] of Object.entries(frames)) {
      if (name === 'hello') continue
      expect(typeof frame.t, name).toBe('number')
    }
  })

  it("sign the box's first frame as GET /api/identity signs", () => {
    const { signed } = fixtures
    expect(identityStatement(signed.eventId, signed.host, signed.nonce).toString()).toBe(
      signed.statement
    )
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: Buffer.from(signed.key, 'base64url').subarray(1, 33).toString('base64url'),
        y: Buffer.from(signed.key, 'base64url').subarray(33).toString('base64url'),
      },
      format: 'jwk',
    })
    const check = (statement: string) =>
      verify(
        'sha256',
        Buffer.from(statement),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signed.signature, 'base64url')
      )
    expect(frames.box!.signature).toBe(signed.signature)
    expect(check(signed.statement)).toBe(true)
    expect(
      check(identityStatement(signed.eventId, signed.wrongHost, signed.nonce).toString())
    ).toBe(false)
  })
})
