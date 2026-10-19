import { describe, expect, it } from 'vitest'
import {
  CUE_STALE_MS,
  cueAlert,
  cueStep,
  PANIC_STALE_MS,
  type Alert,
  type Cue,
  type ServerMessage,
  type User,
} from '@crewbox/shared'
import { CueDesk, type CueSink } from '../src/cues.ts'

/**
 * Cue lights and the panic button, as rules and as the box's desk
 * (shared/src/cues.ts, server/src/cues.ts). The socket's half is in
 * cuesSocket.test.ts.
 */

const user = (id: string, name: string): User => ({ id, name, role: 'member', createdAt: 0 })
const sam = user('u-sam', 'Sam')
const jo = user('u-jo', 'Jo')
const ali = user('u-ali', 'Ali')
const people = new Map([sam, jo, ali].map((u) => [u.id, u]))

function desk(start = 1_000_000) {
  let now = start
  const told: ServerMessage[] = []
  const alerts: { to: string; alert: Alert }[] = []
  const everyone: { alert: Alert; except: string[] }[] = []
  const withdrawn: string[][] = []
  const posted: string[] = []
  const sink: CueSink = {
    broadcast: (msg) => told.push(msg),
    alert: (to, alert) => alerts.push({ to, alert }),
    alertEveryone: (alert, except) => everyone.push({ alert, except }),
    withdraw: (ids) => withdrawn.push(ids),
    systemMessage: (_channel, body) => posted.push(body),
  }
  const cues = new CueDesk(
    sink,
    { getUserById: (id) => people.get(id) },
    () => 'c-general',
    (stage) => (stage === 'Main Stage' ? 'The Hollows' : ''),
    () => now
  )
  return {
    cues,
    told,
    alerts,
    everyone,
    withdrawn,
    posted,
    tick: (ms: number) => (now += ms),
  }
}

const standby = (d: ReturnType<typeof desk>, label = 'Pyro 1', stage = 'Main Stage') => {
  const cue = d.cues.standby(sam, { targetId: jo.id, label, stage })
  if (typeof cue === 'string') throw new Error(cue)
  return cue
}

describe('a cue light', () => {
  it('goes standby, standing by, GO, and the operator is buzzed for the first and last', () => {
    const d = desk()
    const cue = standby(d)
    expect(cue).toMatchObject({ state: 'standby', actName: 'The Hollows', target: { id: jo.id } })
    expect(d.alerts.at(-1)).toMatchObject({
      to: jo.id,
      alert: { id: `q:${cue.id}`, kind: 'cue', title: 'Standby: Pyro 1', urgent: true },
    })
    expect(d.alerts.at(-1)!.alert.body).toBe(
      'Sam needs you standing by · Main Stage, during The Hollows'
    )

    d.tick(5_000)
    const ready = d.cues.step(cue.id, 'ready', jo) as Cue
    expect(ready).toMatchObject({ state: 'ready', readyAt: 1_005_000 })
    // The caller hears that Jo is standing by.
    expect(d.alerts.at(-1)).toMatchObject({
      to: sam.id,
      alert: { title: 'Jo is standing by', urgent: false },
    })

    d.tick(10_000)
    const went = d.cues.step(cue.id, 'go', sam) as Cue
    expect(went).toMatchObject({ state: 'go', goAt: 1_015_000, endedAt: 1_015_000, by: null })
    // GO replaces the standby on the lock screen: same id, never quiet.
    expect(d.alerts.at(-1)).toMatchObject({
      to: jo.id,
      alert: { id: `q:${cue.id}`, title: 'GO: Pyro 1', quiet: false },
    })
    expect(d.told.map((m) => m.type === 'cue' && m.cue.state)).toEqual([
      'standby',
      'ready',
      'go',
    ])
  })

  it('is answered by the operator alone', () => {
    // A caller answering their own standby is the one lie a cue light must
    // never tell.
    const d = desk()
    const cue = standby(d)
    expect(d.cues.step(cue.id, 'ready', sam)).toBe('not-yours')
    expect(d.cues.step(cue.id, 'ready', ali)).toBe('not-yours')
    expect(d.cues.step(cue.id, 'ready', jo)).toMatchObject({ state: 'ready' })
  })

  it('can be finished by whoever takes the call over, and says who', () => {
    // The caller's phone is the one that dies at the wrong moment.
    const d = desk()
    const cue = standby(d)
    expect(d.cues.step(cue.id, 'go', ali)).toMatchObject({ state: 'go', by: { id: ali.id } })
    expect(d.alerts.at(-1)!.alert.body).toBe(
      'Ali called GO · Main Stage, during The Hollows'
    )
  })

  it('stood down, comes off the lock screen', () => {
    const d = desk()
    const cue = standby(d)
    expect(d.cues.step(cue.id, 'stand-down', sam)).toMatchObject({ state: 'stood-down' })
    expect(d.withdrawn).toEqual([[`q:${cue.id}`]])
    // And is history: a second press finds nothing live.
    expect(d.cues.step(cue.id, 'go', sam)).toBe('no-such-cue')
  })

  it('needs somebody to stand by', () => {
    const d = desk()
    expect(d.cues.standby(sam, { targetId: 'u-gone', label: 'VT', stage: '' })).toBe(
      'no-such-person'
    )
  })

  it('has no running order to quote when no stage is named', () => {
    const d = desk()
    const cue = d.cues.standby(sam, { targetId: jo.id, label: 'Walk-on', stage: '' }) as Cue
    expect(cue.actName).toBe('')
    expect(cueAlert(cue, 0).body).toBe('Sam needs you standing by')
  })

  it('left lit for half an hour is stood down by the box', () => {
    const d = desk()
    const cue = standby(d)
    d.tick(CUE_STALE_MS - 1)
    d.cues.sweep()
    expect(d.cues.snapshot().cues[0]!.state).toBe('standby')
    d.tick(1)
    d.cues.sweep()
    expect(d.cues.snapshot().cues[0]).toMatchObject({ id: cue.id, state: 'stood-down' })
  })

  it('rings again for a phone that comes back while it is live', () => {
    const d = desk()
    const cue = standby(d)
    expect(d.cues.liveAlertsFor(jo.id).map((a) => a.id)).toEqual([`q:${cue.id}`])
    expect(d.cues.liveAlertsFor(ali.id)).toEqual([])
    d.cues.step(cue.id, 'go', sam)
    // GO, for a minute; then it is history.
    expect(d.cues.liveAlertsFor(jo.id)[0]!.title).toBe('GO: Pyro 1')
    d.tick(60_000)
    expect(d.cues.liveAlertsFor(jo.id)).toEqual([])
  })

  it('goes with the account of either person in it', () => {
    const d = desk()
    standby(d)
    d.cues.forget(jo.id)
    expect(d.cues.snapshot().cues[0]!.state).toBe('stood-down')
  })
})

describe('the steps a cue can take', () => {
  const cue: Cue = {
    id: 'q1',
    label: 'Pyro 1',
    stage: '',
    actName: '',
    target: { id: jo.id, name: 'Jo' },
    caller: { id: sam.id, name: 'Sam' },
    state: 'standby',
    standbyAt: 0,
    readyAt: null,
    goAt: null,
    by: null,
    endedAt: null,
  }

  it.each([
    ['standby', 'ready', jo, 'ready'],
    ['standby', 'go', sam, 'go'],
    ['ready', 'go', sam, 'go'],
    ['ready', 'stand-down', jo, 'stood-down'],
    ['ready', 'ready', jo, null],
    ['go', 'go', sam, null],
    ['stood-down', 'go', sam, null],
  ] as const)('%s, then %s by %s, is %s', (state, step, who, expected) => {
    const next = cueStep({ ...cue, state }, step, { id: who.id, name: who.name }, 10)
    expect(next?.state ?? null).toBe(expected)
  })
})

describe('the panic button', () => {
  it('rings everyone but the person who held it, and posts the record', () => {
    const d = desk()
    const panic = d.cues.panic(jo)
    if (typeof panic === 'string') throw new Error(panic)
    expect(d.everyone).toHaveLength(1)
    expect(d.everyone[0]).toMatchObject({
      except: [jo.id],
      alert: { id: `p:${panic.id}`, kind: 'panic', title: 'Jo needs help', urgent: true },
    })
    expect(d.everyone[0]!.alert.target).toEqual({ kind: 'channel', channelId: 'c-general' })
    expect(d.posted).toEqual(['🆘 Jo held the panic button and needs help.'])
  })

  it('held again while live is the same call', () => {
    const d = desk()
    const first = d.cues.panic(jo)
    expect(d.cues.panic(jo)).toEqual(first)
    expect(d.everyone).toHaveLength(1)
  })

  it('tells the person who is coming, once each', () => {
    const d = desk()
    const panic = d.cues.panic(jo) as { id: string }
    d.cues.panicStep(panic.id, 'respond', ali)
    d.cues.panicStep(panic.id, 'respond', ali)
    d.cues.panicStep(panic.id, 'respond', jo)
    expect(d.cues.snapshot().panics[0]!.responders.map((r) => r.name)).toEqual(['Ali'])
    expect(d.alerts).toEqual([
      expect.objectContaining({ to: jo.id, alert: expect.objectContaining({ title: 'Ali is on the way' }) }),
    ])
    expect(d.posted.at(-1)).toBe('Ali is on the way to Jo.')
  })

  it('stood down, comes off every lock screen and says who ended it', () => {
    const d = desk()
    const panic = d.cues.panic(jo) as { id: string }
    d.cues.panicStep(panic.id, 'respond', ali)
    d.cues.panicStep(panic.id, 'stand-down', ali)
    expect(d.withdrawn).toEqual([[`p:${panic.id}`, `p:${panic.id}:${ali.id}`]])
    expect(d.posted.at(-1)).toBe("Ali stood down Jo's call for help.")
    expect(d.cues.snapshot().panics).toEqual([])
    expect(d.cues.panicStep(panic.id, 'respond', sam)).toBe('no-such-call')
  })

  it('stood down by the person themselves says they are OK', () => {
    const d = desk()
    const panic = d.cues.panic(jo) as { id: string }
    d.cues.panicStep(panic.id, 'stand-down', jo)
    expect(d.posted.at(-1)).toBe('Jo is OK and stood down their call for help.')
  })

  it('rings a phone that comes back while it is live, but not the person who called', () => {
    const d = desk()
    const panic = d.cues.panic(jo) as { id: string }
    expect(d.cues.liveAlertsFor(sam.id).map((a) => a.id)).toEqual([`p:${panic.id}`])
    expect(d.cues.liveAlertsFor(jo.id)).toEqual([])
  })

  it('lapses after two hours, and says so', () => {
    const d = desk()
    d.cues.panic(jo)
    d.tick(PANIC_STALE_MS)
    d.cues.sweep()
    expect(d.cues.snapshot().panics).toEqual([])
    expect(d.posted.at(-1)).toBe(
      "Jo's call for help lapsed after two hours without being stood down."
    )
  })
})
