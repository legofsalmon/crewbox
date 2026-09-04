import { relative, type StageAgenda } from '@crewbox/shared'

/**
 * The line under a stage in the sidebar: when the thing on it changes.
 *
 * "done" used to be the fallback for every case that was not a countdown,
 * including a stage with a band on it right now whose slot has no end time —
 * which is most of them until somebody fills the times in, and all of them
 * on a running order typed in a hurry at load-in. So the sidebar said
 * "The Harbour Lights · done" while The Harbour Lights were playing, which
 * is the one thing a production desk reads that line to find out.
 *
 * The order is what is happening, not what is known: on now first, then
 * what is next, and only a stage with neither is done for the night.
 */
export function stageCountdown(stage: StageAgenda): string {
  const playing = stage.onNow
  if (playing) return playing.endsIn != null ? `off ${relative(playing.endsIn)}` : 'on now'
  const upcoming = stage.next
  if (upcoming) return upcoming.startsIn != null ? relative(upcoming.startsIn) : 'TBC'
  return 'done'
}
