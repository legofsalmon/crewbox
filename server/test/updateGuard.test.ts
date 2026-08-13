import { describe, expect, it } from 'vitest'
import { describeInterruption, type ShowState } from '../src/update/guard.ts'
import type { StageBoard } from '../src/control.ts'

/**
 * What an admin is told before they interrupt a show.
 *
 * The one property worth guarding above all others: **this never blocks.** A
 * box that refuses to update during a show is a box that cannot be fixed
 * during a show. Everything else here is about the warning being specific
 * enough to decide on, rather than an "are you sure?" everybody clicks past.
 */

const act = (name: string, stage: string, endsIn: number | null): StageBoard => ({
  stage,
  onNow: { name, stage, startsIn: -10, endsIn, starts: '', ends: '' },
  next: null,
})

const quiet: ShowState = { connections: 0, onlineUsers: 0, board: [] }

describe('never standing in the way', () => {
  it('cannot block, whatever is happening', () => {
    const busy: ShowState = {
      connections: 40,
      onlineUsers: 30,
      board: [act('Fontaines D.C.', 'Main Stage', 35)],
    }
    expect(describeInterruption(busy).blocks).toBe(false)
    expect(describeInterruption(quiet).blocks).toBe(false)
  })

  it('still says something on a box with nobody on it', () => {
    // Even a quiet box drops comms for a moment, and somebody watching a
    // spinner deserves to know it was expected.
    const result = describeInterruption(quiet)
    expect(result.quiet).toBe(true)
    expect(result.lines.length).toBe(1)
    expect(result.lines[0]).toContain('seconds')
  })
})

describe('naming what gets interrupted', () => {
  it('leads with the act that finishes soonest', () => {
    // The tightest window is the one worth reading first — a reader who
    // stops after one line has still read the thing that matters.
    const state: ShowState = {
      connections: 12,
      onlineUsers: 12,
      board: [act('Headliner', 'Main', 90), act('Support', 'Tent', 8)],
    }
    const { lines } = describeInterruption(state)
    expect(lines[0]).toContain('Support')
    expect(lines[0]).toContain('8 minutes')
    expect(lines[1]).toContain('Headliner')
  })

  it('names the stage, so a reader knows who to ask', () => {
    const state: ShowState = { ...quiet, board: [act('Fontaines D.C.', 'Main Stage', 35)] }
    expect(describeInterruption(state).lines[0]).toBe(
      'Main Stage: Fontaines D.C. is on for another 35 minutes.'
    )
  })

  it('says how many people lose comms', () => {
    const state: ShowState = { connections: 14, onlineUsers: 14, board: [] }
    expect(describeInterruption(state).lines[0]).toContain('14 people connected')
  })

  it('counts devices too when somebody has two', () => {
    // The number of screens that go blank is the number people notice.
    const state: ShowState = { connections: 20, onlineUsers: 14, board: [] }
    expect(describeInterruption(state).lines[0]).toContain('on 20 devices')
  })

  it('does not mention devices when they match the head count', () => {
    const state: ShowState = { connections: 14, onlineUsers: 14, board: [] }
    expect(describeInterruption(state).lines[0]).not.toContain('device')
  })

  it('reads as English for one of anything', () => {
    const state: ShowState = { connections: 1, onlineUsers: 1, board: [act('Soundcheck', 'Main', 1)] }
    const { lines } = describeInterruption(state)
    expect(lines[0]).toContain('another 1 minute.')
    expect(lines[1]).toContain('1 person connected')
  })

  it('handles an act with no end time without inventing one', () => {
    // A TBC slot is on, but nobody knows for how long. Saying so beats
    // guessing, and beats leaving it out.
    const state: ShowState = { ...quiet, board: [act('TBC', 'Tent', null)] }
    expect(describeInterruption(state).lines[0]).toBe('Tent: TBC is on now.')
  })

  it('copes with a half-typed act that has no name', () => {
    const state: ShowState = { ...quiet, board: [act('', 'Tent', 20)] }
    expect(describeInterruption(state).lines[0]).toContain('an unnamed act')
  })

  it('copes with an act on no particular stage', () => {
    const state: ShowState = { ...quiet, board: [act('Fireworks', '', 5)] }
    expect(describeInterruption(state).lines[0]).toBe('Fireworks is on for another 5 minutes.')
  })

  it('ignores stages with nothing on them', () => {
    const state: ShowState = {
      ...quiet,
      board: [{ stage: 'Empty', onNow: null, next: null }, act('Live', 'Main', 10)],
    }
    const { lines } = describeInterruption(state)
    expect(lines.filter((l) => l.includes('Empty'))).toEqual([])
    expect(lines[0]).toContain('Live')
  })
})

describe('the outage', () => {
  it('is always the last thing said, and always said', () => {
    for (const state of [quiet, { connections: 5, onlineUsers: 5, board: [act('A', 'B', 3)] }]) {
      const { lines } = describeInterruption(state)
      expect(lines.at(-1)).toContain('restarts')
    }
  })

  it('reports the number it was given', () => {
    const result = describeInterruption(quiet, 45)
    expect(result.outageSeconds).toBe(45)
    expect(result.lines.at(-1)).toContain('45 seconds')
  })
})
