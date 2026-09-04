import type { UpdateFlow } from './api.ts'

/**
 * Reading the outcome of an install the box cannot report.
 *
 * The install request is served by the process the install is about to
 * replace, and releasing the port destroys the socket carrying it. So the
 * *successful* case never replies, and the 500 a rollback produces cannot get
 * back either. Both look identical from the panel: a rejected fetch. Treating
 * that rejection as the good news is how a rollback used to be shown to an
 * admin as a completed update — at two in the morning, on a box now running
 * the version they thought they had just replaced.
 *
 * Nothing here can be learnt from the request. It has to be polled for, and
 * these two functions are the whole of what the polling means.
 */

/** What this panel is waiting for, which the box's own stage cannot say. */
export type UpdatePhase = 'idle' | 'watching' | 'restarted'

/** What the panel draws. The box's stages, plus the one only it knows. */
export type ShownStage = UpdateFlow['stage'] | 'restarted'

/**
 * What one poll during an install found.
 *
 * - `stage`: the box answered as itself, so this is still the old process and
 *   its stage is the truth.
 * - `locked`: a 403. Admin unlocks live in one process's memory, so a box
 *   holding none of them is a box that restarted — the only positive evidence
 *   an install succeeded that exists anywhere.
 * - `silent`: no answer. The box is down mid-restart, or the panel cannot
 *   reach it. Not news, and not an answer.
 */
export type PollAnswer =
  { kind: 'stage'; stage: UpdateFlow['stage'] } | { kind: 'locked' } | { kind: 'silent' }

/**
 * Where the panel goes next.
 *
 * Only meaningful while watching: a 403 at any other time is an ordinary
 * expired unlock, and reading it as "the box restarted" would announce an
 * update nobody started.
 */
export function nextPhase(phase: UpdatePhase, answer: PollAnswer): UpdatePhase {
  if (phase !== 'watching') return phase
  if (answer.kind === 'locked') return 'restarted'
  // Still the old process. Once its stage stops saying `installing` there is
  // an outcome to show — for a rollback, the failure with its reason in it.
  if (answer.kind === 'stage' && answer.stage !== 'installing') return 'idle'
  return 'watching'
}

/**
 * What to draw: the box's own stage, until the box stops being able to answer.
 *
 * From the moment Install is pressed the phase leads. The stage the panel is
 * holding is `ready` — the box went off the air before it could say anything
 * else — and drawing that would put the Install button back on screen
 * underneath "the box is restarting".
 */
export function shownStage(phase: UpdatePhase, stage: UpdateFlow['stage']): ShownStage {
  if (phase === 'restarted') return 'restarted'
  if (phase === 'watching') return 'installing'
  return stage
}
