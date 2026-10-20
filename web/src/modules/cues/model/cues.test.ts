import { describe, expect, it } from 'vitest'
import type { Cue, User } from '@crewbox/shared'
import { answeredIn, cueStatus, peopleToCue, splitCues } from './cues.ts'

const cue = (over: Partial<Cue> = {}): Cue => ({
  id: 'q1',
  label: 'Pyro 1',
  stage: '',
  actName: '',
  target: { id: 'u-jo', name: 'Jo' },
  caller: { id: 'u-sam', name: 'Sam' },
  state: 'standby',
  standbyAt: 1_000_000,
  readyAt: null,
  goAt: null,
  by: null,
  endedAt: null,
  ...over,
})

describe('what the pane says about a cue', () => {
  it('names who it is waiting on, and who is standing by', () => {
    expect(cueStatus(cue())).toBe('Waiting for Jo')
    expect(cueStatus(cue({ state: 'ready', readyAt: 1_012_000 }))).toBe('Jo is standing by')
  })

  it('says when the operator couldn’t, apart from somebody standing it down', () => {
    const down = cue({ state: 'stood-down', endedAt: 1_020_000 })
    expect(cueStatus(down)).toBe('Stood down')
    expect(cueStatus({ ...down, by: { id: 'u-jo', name: 'Jo' } })).toBe('Jo couldn’t stand by')
    expect(cueStatus({ ...down, by: { id: 'u-ali', name: 'Ali' } })).toBe('Stood down by Ali')
  })

  it('names who called GO when it was not the caller', () => {
    const at = new Date(2026, 9, 19, 21, 32, 5).getTime()
    expect(cueStatus(cue({ state: 'go', goAt: at }))).toBe('GO at 21:32:05')
    expect(cueStatus(cue({ state: 'go', goAt: at, by: { id: 'u-ali', name: 'Ali' } }))).toBe(
      'GO at 21:32:05, called by Ali'
    )
  })

  it('says how long the operator took to answer', () => {
    expect(answeredIn(cue())).toBe('not answered')
    expect(answeredIn(cue({ readyAt: 1_012_400 }))).toBe('answered in 12 s')
    expect(answeredIn(cue({ readyAt: 1_000_000 + 150_000 }))).toBe('answered in 3 min')
  })

  it('keeps live cues apart from history', () => {
    const { live, done } = splitCues([
      cue({ id: 'a' }),
      cue({ id: 'b', state: 'go' }),
      cue({ id: 'c', state: 'ready' }),
    ])
    expect(live.map((c) => c.id)).toEqual(['a', 'c'])
    expect(done.map((c) => c.id)).toEqual(['b'])
  })
})

describe('who a standby can go to', () => {
  const user = (id: string, name: string): User => ({ id, name, role: 'member', createdAt: 0 })
  const users = Object.fromEntries(
    [user('u-sam', 'Sam'), user('u-jo', 'Jo'), user('u-ali', 'Ali'), user('u-bo', 'Bo')].map(
      (u) => [u.id, u]
    )
  )

  it('is everyone but you, online first, then by name', () => {
    const list = peopleToCue(users, { 'u-jo': true, 'u-sam': true }, 'u-sam')
    expect(list.map((p) => [p.user.name, p.online])).toEqual([
      ['Jo', true],
      ['Ali', false],
      ['Bo', false],
    ])
  })
})
