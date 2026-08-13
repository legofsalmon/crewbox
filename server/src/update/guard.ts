import { TYPICAL_OUTAGE_SECONDS } from './restart.ts'
import type { StageBoard } from '../control.ts'

/**
 * Telling an admin what an update is about to interrupt.
 *
 * **This warns and never blocks.** That was a deliberate decision and it is
 * worth stating rather than discovering: a box that refuses to update during a
 * show is a box that cannot be fixed during a show, and "the update button
 * would not let me" is a worse thing to say at two in the morning than "I
 * updated it and it took twenty seconds". The person at the box knows things
 * this code does not — that the stage is dark, that the act on screen finished
 * early, that comms are already down and that is exactly why they are here.
 *
 * What it owes them instead is **specifics**. "Are you sure?" is a dialog
 * everybody clicks through. "Fourteen crew connected, Fontaines D.C. on the
 * Main Stage for another 35 minutes, comms drop for about 20 seconds" is a
 * sentence somebody can actually make a decision with — and, if they decide to
 * wait, one they can repeat to a stage manager.
 *
 * So the shape below has no `allowed` field to check and no way to say no. It
 * carries facts and a number of seconds.
 */

export interface ShowState {
  /** Sockets attached right now — phones, desks, tablets. */
  connections: number
  /** Distinct crew members, which is the number a person cares about. */
  onlineUsers: number
  /** What the running order says is happening, straight from the shell. */
  board: StageBoard[]
}

export interface Interruption {
  /**
   * Always false. Present so the type says out loud what the prose above
   * says: nothing here can stop an update, and a caller looking for the
   * permission check will find this instead and read why.
   */
  blocks: false
  /** Roughly how long every phone loses the box for. */
  outageSeconds: number
  /** True when there is genuinely nothing going on. */
  quiet: boolean
  /**
   * What is about to be interrupted, most alarming first, each a complete
   * sentence. Written to be read out to somebody else.
   */
  lines: string[]
}

/**
 * Round minutes into something a person would say.
 *
 * "another 35 minutes" and "another 2 minutes" are both useful; "another 35.4
 * minutes" is a machine talking, and at the point somebody is deciding whether
 * to interrupt a show, sounding like a machine costs trust.
 */
function minutes(n: number): string {
  const whole = Math.max(1, Math.round(n))
  return whole === 1 ? '1 minute' : `${whole} minutes`
}

function people(n: number): string {
  return n === 1 ? '1 person' : `${n} people`
}

/**
 * Describe what restarting now would interrupt.
 *
 * Ordered by what would hurt most: an act mid-set first, because that is the
 * one with a hard deadline attached; then who loses comms; then the outage
 * itself. A reader who stops after the first line has still read the thing
 * that matters.
 */
export function describeInterruption(
  state: ShowState,
  outageSeconds: number = TYPICAL_OUTAGE_SECONDS
): Interruption {
  const lines: string[] = []

  // Acts currently on, soonest to finish first — the tightest window is the
  // one worth naming first.
  const onNow = state.board
    .filter((s) => s.onNow !== null)
    .map((s) => ({ stage: s.stage, entry: s.onNow! }))
    .sort((a, b) => (a.entry.endsIn ?? Infinity) - (b.entry.endsIn ?? Infinity))

  for (const { stage, entry } of onNow) {
    const who = entry.name || 'an unnamed act'
    const where = stage ? `${stage}: ` : ''
    lines.push(
      entry.endsIn === null
        ? `${where}${who} is on now.`
        : `${where}${who} is on for another ${minutes(entry.endsIn)}.`
    )
  }

  if (state.onlineUsers > 0) {
    // Connections rather than users when somebody has two devices, because
    // the number of screens that go blank is the number people notice.
    const extra =
      state.connections > state.onlineUsers
        ? ` on ${state.connections} device${state.connections === 1 ? '' : 's'}`
        : ''
    lines.push(`${people(state.onlineUsers)} connected${extra} — everyone loses comms.`)
  }

  lines.push(
    `Chat, voice and every module go down for about ${outageSeconds} seconds while the box restarts.`
  )

  return {
    blocks: false,
    outageSeconds,
    quiet: onNow.length === 0 && state.onlineUsers === 0,
    lines,
  }
}
