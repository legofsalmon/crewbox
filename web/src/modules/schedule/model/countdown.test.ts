import { describe, expect, it } from 'vitest'
import { stageCountdown } from './countdown.ts'
import type { AgendaAct, StageAgenda } from '@crewbox/shared'

/**
 * "done" was the fallback for every case that was not a countdown —
 * including a stage with a band on it right now whose slot has no end time,
 * which is most of them until somebody fills the times in. So the sidebar
 * said "The Harbour Lights · done" while The Harbour Lights were playing,
 * which is the one thing a production desk reads that line to find out.
 */

const act = (name: string): AgendaAct => ({
  id: name,
  name,
  stage: 'Main',
  date: '2026-07-24',
  start: null,
  end: null,
  changeover: 0,
})

const stage = (over: Partial<StageAgenda> = {}): StageAgenda => ({
  stage: 'Main',
  onNow: null,
  next: null,
  ...over,
})

describe('what the sidebar says under a stage', () => {
  it('counts an act off when it has an end time', () => {
    const line = stageCountdown(
      stage({ onNow: { act: act('The Harbour Lights'), startsIn: -20, endsIn: 25 } })
    )
    expect(line).toContain('off')
    expect(line).toContain('25')
  })

  it('says an act is on, when it is on and nobody typed an end time', () => {
    // The case that read "done" — a running order typed in a hurry at
    // load-in, which is all of them.
    expect(
      stageCountdown(
        stage({ onNow: { act: act('The Harbour Lights'), startsIn: -20, endsIn: null } })
      )
    ).toBe('on now')
  })

  it('prefers what is on to what is next', () => {
    // A stage with an act on *and* one coming: the desk wants the one in
    // front of them.
    expect(
      stageCountdown(
        stage({
          onNow: { act: act('Now'), startsIn: -5, endsIn: null },
          next: { act: act('Later'), startsIn: 40, endsIn: null },
        })
      )
    ).toBe('on now')
  })

  it('counts down to the next act when nothing is on', () => {
    expect(
      stageCountdown(stage({ next: { act: act('Later'), startsIn: 40, endsIn: null } }))
    ).toContain('40')
  })

  it('says TBC for a next act with no time yet', () => {
    // Also read "done" before, on a stage whose whole running order was
    // still to be confirmed.
    expect(stageCountdown(stage({ next: { act: act('TBC'), startsIn: null, endsIn: null } }))).toBe(
      'TBC'
    )
  })

  it('says done only when there is nothing on and nothing left', () => {
    expect(stageCountdown(stage())).toBe('done')
  })
})
