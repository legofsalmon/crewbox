import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Act, Alert, AlertsWelcomeFrame, StageCountdown } from '@crewbox/shared'
import { StageCalls } from '../src/alertCalls.ts'
import { TIMETABLE_ROOM } from '../src/control.ts'
import { Client, startBox, type Box } from './support/box.ts'

/**
 * Changeover calls, the show log's alerts and the lock-screen countdown
 * (docs/ALERTS.md), on a clock the tests move by hand.
 */

function runningOrder(acts: Act[]): Y.Doc {
  const doc = new Y.Doc()
  const list = doc.getArray<Y.Map<unknown>>('acts')
  for (const act of acts) {
    const entry = new Y.Map<unknown>()
    for (const [key, value] of Object.entries(act)) entry.set(key, value)
    list.push([entry])
  }
  return doc
}

const act = (id: string, name: string, start: string, end: string): Act => ({
  id,
  name,
  stage: 'Main Stage',
  date: '2026-07-10',
  start,
  end,
  changeover: 0,
})

/** 10 July 2026 at a London wall-clock time, as an instant. */
const london = (hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(2026, 6, 10, h! - 1, m!))
}

function rig(acts: Act[], at: string) {
  let doc = runningOrder(acts)
  let now = london(at)
  const calls: Alert[] = []
  const withdrawn: string[][] = []
  let stagesChanged = 0
  const source = new StageCalls(
    { peek: (name) => (name === TIMETABLE_ROOM ? doc : null) },
    {
      onCall: (alert) => calls.push(alert),
      withdraw: (ids) => withdrawn.push(ids),
      onStagesChanged: () => stagesChanged++,
    },
    () => now,
    'Europe/London'
  )
  return {
    source,
    calls,
    withdrawn,
    stagesChanged: () => stagesChanged,
    at(hhmm: string) {
      now = london(hhmm)
      source.tick()
    },
    replace(next: Act[]) {
      doc = runningOrder(next)
    },
  }
}

describe('changeover calls', () => {
  const tonight = [
    act('a-1', 'Night Bus', '20:00', '21:00'),
    act('a-2', 'The Hollows', '21:30', '22:30'),
  ]

  it('are made once each, in the minute they are due', () => {
    const r = rig(tonight, '20:50')
    r.source.tick()
    expect(r.calls).toEqual([])
    r.at('20:59')
    r.at('21:00')
    r.at('21:00')
    expect(r.calls.map((c) => [c.title, c.body, c.urgent])).toEqual([
      ['Changeover on Main Stage', 'The Hollows on in 30 min', true],
    ])
    r.at('21:25')
    expect(r.calls.map((c) => c.title)).toContain('The Hollows on in 5 min')
    expect(r.calls).toHaveLength(2)
  })

  it('never call late what was already past when the box started', () => {
    const r = rig(tonight, '21:10')
    r.source.tick()
    r.at('21:11')
    expect(r.calls).toEqual([])
  })

  it('never call twice when the clock steps back', () => {
    const r = rig(tonight, '20:59')
    r.source.tick()
    r.at('21:00')
    r.at('20:58')
    r.at('21:01')
    expect(r.calls).toHaveLength(1)
  })

  it('follow a set that moves: the old calls withdrawn, a moved call, and re-armed', () => {
    const r = rig(tonight, '20:30')
    r.source.tick()
    r.at('21:00')
    expect(r.calls.map((c) => c.id)).toEqual(['c:a-2:changeover:2026-07-10:1290'])
    r.replace([act('a-1', 'Night Bus', '20:00', '21:00'), act('a-2', 'The Hollows', '21:45', '')])
    r.at('21:02')
    expect(r.withdrawn).toEqual([['c:a-2:changeover:2026-07-10:1290']])
    const moved = r.calls.at(-1)!
    expect([moved.title, moved.body, moved.urgent]).toEqual([
      'The Hollows now on at 21:45',
      'Main Stage, was 21:30',
      false,
    ])
    r.at('21:40')
    expect(r.calls.at(-1)!.id).toBe('c:a-2:soon:2026-07-10:1305')
    expect(r.stagesChanged()).toBe(2)
  })

  it('are kept for a catch-up for a while', () => {
    const r = rig(tonight, '20:59')
    r.source.tick()
    r.at('21:00')
    expect(r.source.recentCalls(london('20:59').getTime())).toHaveLength(1)
    expect(r.source.recentCalls(london('21:01').getTime())).toHaveLength(0)
  })
})

describe('the countdown', () => {
  it('is the followed stages, in the zone asked for', () => {
    const r = rig(
      [act('a-1', 'Night Bus', '20:00', '21:00'), act('a-2', 'The Hollows', '21:30', '22:30')],
      '20:30'
    )
    r.source.tick()
    const [stage] = r.source.countdown(['Main Stage'], 'Europe/London')
    expect(stage!.onNow).toMatchObject({ name: 'Night Bus', end: london('21:00').getTime() })
    expect(stage!.next).toMatchObject({ name: 'The Hollows', start: london('21:30').getTime() })
    expect(r.source.countdown(['Tent'], 'Europe/London')).toEqual([])
    // No zone from the phone: the festival's.
    expect(r.source.countdown(['Main Stage'], undefined)).toEqual([stage])
  })
})

describe('on the alerts socket', () => {
  let box: Box
  const clients: { close(): void }[] = []
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close()
    await box.stop()
  })

  type Frame = { type: string; [key: string]: unknown }

  async function phone(token: string, since: number | null = null) {
    const client = new Client<Frame>(
      `ws://127.0.0.1:${box.port}/ws/alerts?nonce=${randomBytes(16).toString('base64url')}`
    )
    clients.push(client)
    await client.open()
    await client.waitFor((m) => m.type === 'box')
    client.send({ type: 'hello', token, since, timeZone: 'Europe/London' })
    const welcome = await client.waitFor<AlertsWelcomeFrame>((m) => m.type === 'welcome')
    return { client, welcome }
  }

  it('buzzes everyone but its author for a show stop, and not for one logged late', async () => {
    box = await startBox()
    const jo = await box.join('Jo')
    const sam = await box.join('Sam')
    const { client: joChat } = await box.chat(jo)
    const { client: samPhone } = await phone(sam)
    const { client: joPhone } = await phone(jo)
    const now = Date.now()
    joChat.send({
      type: 'logIncident',
      clientMsgId: 'incident-late-1',
      kind: 'show-stop',
      severity: 'serious',
      body: 'Barrier',
      at: now - 60 * 60_000,
      stage: 'Main Stage',
    })
    joChat.send({
      type: 'logIncident',
      clientMsgId: 'incident-now-1',
      kind: 'show-stop',
      severity: 'serious',
      body: 'Crowd surge at the barrier',
      at: now - 60_000,
      stage: 'Main Stage',
    })
    const got = await samPhone.waitFor<{ alert: Alert }>((m) => m.type === 'alert')
    expect(got.alert).toMatchObject({
      kind: 'showStop',
      title: 'Show stop on Main Stage',
      body: 'Jo: Crowd surge at the barrier',
      urgent: true,
      target: { kind: 'showlog' },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(samPhone.all('alert')).toEqual([])
    expect(joPhone.all('alert')).toEqual([])

    // And it comes back to a phone that was away.
    samPhone.close()
    const { welcome } = await phone(sam, now - 5 * 60_000)
    expect(welcome.catchUp.map((a) => a.id)).toEqual([got.alert.id])
  })

  it("sends the countdown for the stages somebody follows, in the phone's zone", async () => {
    box = await startBox()
    const sam = await box.join('Sam')
    const { client: chat } = await box.chat(sam)
    const { client } = await phone(sam)
    chat.send({ type: 'followStage', stage: 'Main Stage', follow: true })
    const stages = await client.waitFor<{ stages: StageCountdown[] }>((m) => m.type === 'stages')
    // No running order on this box yet: nothing on, and nothing wrong.
    expect(stages.stages).toEqual([])
  })
})
