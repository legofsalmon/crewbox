/**
 * Cue lights and the panic button: the two calls that go to a person rather
 * than a channel.
 *
 * A **cue light** is the silent call a stage manager gives a pyro operator,
 * a CO2 op, a walk-on or playback when the stage is too loud to talk: stand
 * by, the operator answers that they are standing by, then go. Theatre does
 * it with a lamp on a stalk; Green-GO builds it into its beltpacks. Here the
 * lamp is the operator's phone, and the lock screen when the phone is in a
 * pocket (docs/CUES.md).
 *
 * The **panic button** is the other direction: somebody working alone, at
 * height, at a generator, in a car park, holds a button and every phone on
 * site rings, through silent and Do Not Disturb, with five seconds of what
 * they said after it.
 *
 * Both are live state the box holds and every device is shown, not a record
 * people append to, so they are neither the chat log nor a shared document.
 * What has to outlive the moment goes where records already go: a call for
 * help, who went, and when it was stood down are system messages in
 * #general, and the clip is a file message beside them.
 *
 * Pure, like the alert rules: no clock, no store. The box runs these, the
 * page draws from the same shapes.
 */
import type { Alert } from './alerts.js'

// ---------------------------------------------------------------------------
// Cue lights
// ---------------------------------------------------------------------------

/**
 * Where a cue is up to.
 *
 *  - `standby`: called, not yet answered.
 *  - `ready`: the operator has said they are standing by.
 *  - `go`: gone. The light shows GO for `CUE_GO_SHOW_MS`, then the cue is
 *    history.
 *  - `stood-down`: called off before it went.
 */
export const CUE_STATES = ['standby', 'ready', 'go', 'stood-down'] as const
export type CueState = (typeof CUE_STATES)[number]

/** Somebody, as a cue or a call for help remembers them: by id, with the name they had then. */
export interface CuePerson {
  id: string
  name: string
}

export interface Cue {
  id: string
  /** What the operator is standing by for: "Pyro 1", "Walk-on", "VT". */
  label: string
  /** The running order's stage, or ''. */
  stage: string
  /**
   * What was on that stage when the standby was called, by name, or ''.
   * A copy on purpose, as the show log keeps one: the history of a night
   * should keep saying "during The Hollows" after the running order moves.
   */
  actName: string
  /** Who stands by. */
  target: CuePerson
  /** Who called the standby. */
  caller: CuePerson
  state: CueState
  standbyAt: number
  readyAt: number | null
  goAt: number | null
  /** Who pressed GO, or stood it down, when that was somebody other than the caller. */
  by: CuePerson | null
  /** When it went or was stood down; null while it is live. */
  endedAt: number | null
}

/** Longest a cue's label may be: a lamp is labelled, not described. */
export const MAX_CUE_LABEL = 60

/** How long GO stays on the operator's screen before the cue is history. */
export const CUE_GO_SHOW_MS = 8_000

/**
 * How long a standby can wait, unanswered or answered, before the box stands
 * it down by itself. A standby left lit from the last show is a lamp nobody
 * trusts by the next one.
 */
export const CUE_STALE_MS = 30 * 60_000

/** Cues one person may have called that are still live. Bounds a stuck loop, not a real night. */
export const MAX_LIVE_CUES_PER_CALLER = 20

/** How many finished cues the box keeps to show in the pane. */
export const CUE_HISTORY = 40

export const isLiveCue = (cue: Cue): boolean => cue.state === 'standby' || cue.state === 'ready'

/**
 * What a press would do to a cue, and whether this person may do it.
 *
 * Only the operator stands by: a caller answering their own standby would be
 * the one lie a cue light must never tell. Anyone may press GO or stand a cue
 * down, because the caller's phone is exactly the one that dies at the wrong
 * moment and whoever takes over the call has to be able to finish it. Who
 * did is kept (`by`).
 */
export function cueStep(
  cue: Cue,
  step: 'ready' | 'go' | 'stand-down',
  who: CuePerson,
  now: number
): Cue | null {
  if (!isLiveCue(cue)) return null
  const by = who.id === cue.caller.id ? null : who
  switch (step) {
    case 'ready':
      if (who.id !== cue.target.id || cue.state !== 'standby') return null
      return { ...cue, state: 'ready', readyAt: now }
    case 'go':
      return { ...cue, state: 'go', goAt: now, endedAt: now, by }
    case 'stand-down':
      return { ...cue, state: 'stood-down', endedAt: now, by }
  }
}

/** The one notification a cue has on the operator's phone: standby, replaced by GO. */
export const cueAlertId = (cueId: string): string => `q:${cueId}`

/** Where a cue sits in its context: "Main Stage, during The Hollows". */
export function cueWhere(cue: Pick<Cue, 'stage' | 'actName'>): string {
  if (cue.stage && cue.actName) return `${cue.stage}, during ${cue.actName}`
  return cue.stage || cue.actName
}

/**
 * The operator's alert for a cue: the standby, and then GO under the same id
 * so it replaces the standby rather than stacking under it.
 *
 * Never quiet. One sound per thread per 30 seconds is right for a chatty
 * channel and exactly wrong here: a GO twenty seconds after its standby is
 * the alert that matters most.
 */
export function cueAlert(cue: Cue, at: number): Alert {
  const where = cueWhere(cue)
  const go = cue.state === 'go'
  return {
    id: cueAlertId(cue.id),
    kind: 'cue',
    title: go ? `GO: ${cue.label}` : `Standby: ${cue.label}`,
    body: go
      ? `${(cue.by ?? cue.caller).name} called GO${where ? ` · ${where}` : ''}`
      : `${cue.caller.name} needs you standing by${where ? ` · ${where}` : ''}`,
    target: { kind: 'cues' },
    thread: 'cues',
    quiet: false,
    urgent: true,
    at,
  }
}

/**
 * The caller's alert that the operator is standing by. Not urgent: the caller
 * is usually looking at the pane already, and this is for when they are not.
 */
export function cueReadyAlert(cue: Cue, at: number): Alert {
  return {
    id: `${cueAlertId(cue.id)}:ready`,
    kind: 'cue',
    title: `${cue.target.name} is standing by`,
    body: cue.label,
    target: { kind: 'cues' },
    thread: 'cues',
    quiet: false,
    urgent: false,
    at,
  }
}

// ---------------------------------------------------------------------------
// The panic button
// ---------------------------------------------------------------------------

export interface Panic {
  id: string
  /** Who called for help. */
  person: CuePerson
  at: number
  /** Where the record and the clip are posted: #general, which everyone has. */
  channelId: string
  /** Who said they are on their way, in the order they said it. */
  responders: (CuePerson & { at: number })[]
  /** Who stood it down and when; null while it is live. */
  endedBy: CuePerson | null
  endedAt: number | null
}

/** How long a held press must last to call for help. */
export const PANIC_HOLD_MS = 2_000

/** How much of what they say after the press goes with the call. */
export const PANIC_CLIP_MS = 5_000

/**
 * How long a call for help stays live with nobody standing it down. Long
 * enough that nobody's emergency lapses while it is being dealt with, short
 * enough that a forgotten one is not ringing phones at tomorrow's get-in.
 */
export const PANIC_STALE_MS = 2 * 60 * 60_000

export const isLivePanic = (panic: Panic): boolean => panic.endedAt === null

/** The alert every phone gets: the call for help itself. */
export const panicAlertId = (panicId: string): string => `p:${panicId}`

export function panicAlert(panic: Panic, at: number): Alert {
  return {
    id: panicAlertId(panic.id),
    kind: 'panic',
    title: `${panic.person.name} needs help`,
    body: 'Held the panic button. Open crewbox to say you are going.',
    target: { kind: 'channel', channelId: panic.channelId },
    thread: 'panic',
    quiet: false,
    urgent: true,
    at,
  }
}

/** The caller's alert that somebody is on the way. */
export function panicResponderAlert(panic: Panic, responder: CuePerson, at: number): Alert {
  return {
    id: `${panicAlertId(panic.id)}:${responder.id}`,
    kind: 'panic',
    title: `${responder.name} is on the way`,
    body: 'Help is coming.',
    target: { kind: 'channel', channelId: panic.channelId },
    thread: 'panic',
    quiet: false,
    urgent: true,
    at,
  }
}

/** The record in #general, worded once so the box and the tests agree. */
export const panicWords = {
  called: (panic: Panic) => `🆘 ${panic.person.name} held the panic button and needs help.`,
  responding: (panic: Panic, responder: CuePerson) =>
    `${responder.name} is on the way to ${panic.person.name}.`,
  stoodDown: (panic: Panic, by: CuePerson) =>
    by.id === panic.person.id
      ? `${panic.person.name} is OK and stood down their call for help.`
      : `${by.name} stood down ${panic.person.name}'s call for help.`,
  lapsed: (panic: Panic) =>
    `${panic.person.name}'s call for help lapsed after two hours without being stood down.`,
}
