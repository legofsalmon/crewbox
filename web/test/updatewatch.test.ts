import { describe, expect, it } from 'vitest'
import { knownBuild } from '../src/lib/pwa.ts'
import { nextPhase, shownStage, type PollAnswer } from '../src/lib/updatewatch.ts'

/**
 * The install nobody can be told about directly.
 *
 * `releasePort` destroys the socket carrying the install request, so the
 * successful case never replies and the 500 a rollback produces cannot get
 * back either. Both arrive as a rejected fetch. The panel used to read that
 * rejection as "the box is restarting", which is right half the time and, the
 * other half, tells an admin at two in the morning that an update went in
 * when the box put the old version back.
 */

const answer = {
  installing: { kind: 'stage', stage: 'installing' } as PollAnswer,
  failed: { kind: 'stage', stage: 'failed' } as PollAnswer,
  idle: { kind: 'stage', stage: 'idle' } as PollAnswer,
  locked: { kind: 'locked' } as PollAnswer,
  silent: { kind: 'silent' } as PollAnswer,
}

describe('what a poll during an install means', () => {
  it('keeps waiting while the box is down', () => {
    // The whole restart window: no answer at all, for tens of seconds. The
    // one thing that must not happen is calling it either way.
    expect(nextPhase('watching', answer.silent)).toBe('watching')
  })

  it('keeps waiting while the box still says it is installing', () => {
    expect(nextPhase('watching', answer.installing)).toBe('watching')
  })

  it('reads a 403 as the box having restarted', () => {
    // Admin unlocks live in one process's memory. A box holding none of them
    // is a different process, and that is the only evidence of success that
    // reaches this panel at all.
    expect(nextPhase('watching', answer.locked)).toBe('restarted')
  })

  it('stops waiting once the old process reports an outcome', () => {
    // A rollback: the same process answers, with the failure and its reason.
    expect(nextPhase('watching', answer.failed)).toBe('idle')
    expect(nextPhase('watching', answer.idle)).toBe('idle')
  })

  it('ignores a 403 that is just an expired unlock', () => {
    // Outside an install this is somebody's session going stale. Announcing a
    // restart nobody asked for would be worse than saying nothing.
    expect(nextPhase('idle', answer.locked)).toBe('idle')
    expect(nextPhase('restarted', answer.locked)).toBe('restarted')
  })

  it('does not walk back off the restarted state', () => {
    for (const a of Object.values(answer)) expect(nextPhase('restarted', a)).toBe('restarted')
  })
})

describe('what the panel draws', () => {
  it('shows the box its own stage when nothing is being watched', () => {
    for (const stage of ['idle', 'downloading', 'ready', 'failed'] as const) {
      expect(shownStage('idle', stage)).toBe(stage)
    }
  })

  it('shows installing from the press, not from the box catching up', () => {
    // The stage the panel is holding at that moment is `ready`. Drawing it
    // would put the Install button back on screen under "restarting".
    expect(shownStage('watching', 'ready')).toBe('installing')
  })

  it('shows the restart over anything stale the panel is still holding', () => {
    expect(shownStage('restarted', 'ready')).toBe('restarted')
    expect(shownStage('restarted', 'installing')).toBe('restarted')
  })

  it('shows a rollback as the failure it is', () => {
    // Back to idle by then, because the old process answered.
    expect(shownStage('idle', 'failed')).toBe('failed')
  })
})

describe('telling one build from another', () => {
  it('refuses to compare two builds that do not know what they are', () => {
    // A tree with no git — a release tarball — gives both the client and
    // the server a `+unknown` commit, and the two fallbacks used to differ
    // ('dev' here, 'unknown' there), so the strings could never match and
    // the client raised "New version available" against the very build it
    // was talking to, on every welcome, for ever.
    expect(knownBuild('0.18.0+unknown')).toBe(false)
    expect(knownBuild('0.18.0+a1b2c3d')).toBe(true)
  })
})
