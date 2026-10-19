import {
  CUE_HISTORY,
  CUE_STALE_MS,
  cueAlert,
  cueAlertId,
  cueReadyAlert,
  cueStep,
  isLiveCue,
  isLivePanic,
  MAX_LIVE_CUES_PER_CALLER,
  newId,
  PANIC_STALE_MS,
  panicAlert,
  panicAlertId,
  panicResponderAlert,
  panicWords,
  type Alert,
  type Cue,
  type CuePerson,
  type Panic,
  type ServerMessage,
  type User,
} from '@crewbox/shared'

/**
 * Cue lights and the panic button, on the box (shared/src/cues.ts,
 * docs/CUES.md).
 *
 * Held in memory, as the on-air tally is: both are what is happening now,
 * and a box restarting mid-standby loses the standby the way a cue light
 * loses power, visibly, so the caller calls it again. What has to outlive the
 * moment does: a call for help, who went, and when it ended are system
 * messages in #general, so the night's record is where the crew already
 * reads it and survives any restart.
 */

/** How often stale standbys and forgotten calls for help are swept. */
export const CUES_SWEEP_MS = 60_000

/** Where cues and calls for help go: every device, and the alerts that buzz them. */
export interface CueSink {
  /** To every signed-in chat socket. */
  broadcast(msg: ServerMessage): void
  /** One person's phones and pages, always sounding. */
  alert(userId: string, alert: Alert): void
  /** Everyone online, but these. */
  alertEveryone(alert: Alert, except: string[]): void
  withdraw(ids: string[], audience: string[] | null): void
  /** Post a line with no author, as the box's own messages are. */
  systemMessage(channelId: string, body: string): void
}

/** What the running order says is on a stage now, by name, or ''. */
export type OnNow = (stage: string) => string

export type CueRefusal =
  | 'no-such-person'
  | 'no-such-cue'
  | 'not-yours'
  | 'too-many'
  | 'no-channel'
  | 'no-such-call'

const person = (user: User): CuePerson => ({ id: user.id, name: user.name })

export class CueDesk {
  private cues = new Map<string, Cue>()
  private history: Cue[] = []
  private panics = new Map<string, Panic>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly sink: CueSink,
    private readonly users: { getUserById(id: string): User | undefined },
    /** Where calls for help are posted: #general's id, looked up each time. */
    private readonly helpChannel: () => string | undefined,
    private readonly onNow: OnNow = () => '',
    private readonly now: () => number = Date.now
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), CUES_SWEEP_MS)
    this.timer.unref()
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** What a device is told on hello: live cues, recent history, live calls for help. */
  snapshot(): { cues: Cue[]; panics: Panic[] } {
    return {
      cues: [...this.cues.values(), ...this.history],
      panics: [...this.panics.values()],
    }
  }

  /**
   * What a phone coming back to the Wi-Fi should still ring for: a standby
   * or GO it hasn't seen, and any call for help still live. GO only within
   * the minute it was called: a GO from ten minutes ago is history.
   */
  liveAlertsFor(userId: string): Alert[] {
    const now = this.now()
    const alerts: Alert[] = []
    for (const cue of this.cues.values()) {
      if (cue.target.id === userId) alerts.push(cueAlert(cue, cue.standbyAt))
    }
    for (const cue of this.history) {
      if (cue.target.id === userId && cue.goAt !== null && now - cue.goAt < 60_000) {
        alerts.push(cueAlert(cue, cue.goAt))
      }
    }
    for (const panic of this.panics.values()) {
      if (panic.person.id !== userId) alerts.push(panicAlert(panic, panic.at))
    }
    return alerts.sort((a, b) => a.at - b.at)
  }

  // -- cue lights -----------------------------------------------------------

  standby(caller: User, input: { targetId: string; label: string; stage: string }): Cue | CueRefusal {
    const target = this.users.getUserById(input.targetId)
    if (!target) return 'no-such-person'
    const mine = [...this.cues.values()].filter((cue) => cue.caller.id === caller.id)
    if (mine.length >= MAX_LIVE_CUES_PER_CALLER) return 'too-many'
    const now = this.now()
    const cue: Cue = {
      id: newId(),
      label: input.label,
      stage: input.stage,
      actName: input.stage ? this.onNow(input.stage) : '',
      target: person(target),
      caller: person(caller),
      state: 'standby',
      standbyAt: now,
      readyAt: null,
      goAt: null,
      by: null,
      endedAt: null,
    }
    this.cues.set(cue.id, cue)
    this.sink.broadcast({ type: 'cue', cue })
    this.sink.alert(target.id, cueAlert(cue, now))
    return cue
  }

  step(cueId: string, step: 'ready' | 'go' | 'stand-down', who: User): Cue | CueRefusal {
    const cue = this.cues.get(cueId)
    if (!cue) return 'no-such-cue'
    const now = this.now()
    const next = cueStep(cue, step, person(who), now)
    if (!next) return 'not-yours'
    this.apply(next)
    if (step === 'ready') {
      if (cue.caller.id !== who.id) this.sink.alert(cue.caller.id, cueReadyAlert(next, now))
    } else if (step === 'go') {
      // The same id as the standby, so it replaces it on the lock screen.
      this.sink.alert(next.target.id, cueAlert(next, now))
    } else {
      this.sink.withdraw([cueAlertId(next.id)], [next.target.id, next.caller.id])
    }
    return next
  }

  private apply(cue: Cue): void {
    if (isLiveCue(cue)) {
      this.cues.set(cue.id, cue)
    } else {
      this.cues.delete(cue.id)
      this.history = [cue, ...this.history].slice(0, CUE_HISTORY)
    }
    this.sink.broadcast({ type: 'cue', cue })
  }

  // -- the panic button -----------------------------------------------------

  /**
   * Somebody held the panic button. A second hold while their first call is
   * live is the same call, not another: the phones are ringing already, and
   * a second set of alerts would only tell everyone less.
   */
  panic(who: User): Panic | CueRefusal {
    const live = [...this.panics.values()].find((p) => p.person.id === who.id)
    if (live) return live
    const channelId = this.helpChannel()
    if (!channelId) return 'no-channel'
    const now = this.now()
    const panic: Panic = {
      id: newId(),
      person: person(who),
      at: now,
      channelId,
      responders: [],
      endedBy: null,
      endedAt: null,
    }
    this.panics.set(panic.id, panic)
    this.sink.broadcast({ type: 'panic', panic })
    this.sink.alertEveryone(panicAlert(panic, now), [who.id])
    this.sink.systemMessage(channelId, panicWords.called(panic))
    return panic
  }

  panicStep(panicId: string, step: 'respond' | 'stand-down', who: User): Panic | CueRefusal {
    const panic = this.panics.get(panicId)
    if (!panic || !isLivePanic(panic)) return 'no-such-call'
    const now = this.now()
    if (step === 'respond') {
      // Saying it twice is saying it once; and the person in trouble is not
      // on their own way.
      if (who.id === panic.person.id || panic.responders.some((r) => r.id === who.id)) {
        return panic
      }
      const next = { ...panic, responders: [...panic.responders, { ...person(who), at: now }] }
      this.panics.set(next.id, next)
      this.sink.broadcast({ type: 'panic', panic: next })
      this.sink.alert(panic.person.id, panicResponderAlert(next, person(who), now))
      this.sink.systemMessage(panic.channelId, panicWords.responding(next, person(who)))
      return next
    }
    const ended = this.end(panic, person(who), now)
    this.sink.systemMessage(panic.channelId, panicWords.stoodDown(ended, person(who)))
    return ended
  }

  private end(panic: Panic, by: CuePerson | null, now: number): Panic {
    const ended: Panic = { ...panic, endedBy: by, endedAt: now }
    this.panics.delete(panic.id)
    this.sink.broadcast({ type: 'panic', panic: ended })
    this.sink.withdraw(
      [panicAlertId(panic.id), ...panic.responders.map((r) => `${panicAlertId(panic.id)}:${r.id}`)],
      null
    )
    return ended
  }

  // -- housekeeping ---------------------------------------------------------

  /** Stand down standbys and calls for help nobody finished. Public for tests. */
  sweep(): void {
    const now = this.now()
    for (const cue of [...this.cues.values()]) {
      if (now - cue.standbyAt < CUE_STALE_MS) continue
      this.apply({ ...cue, state: 'stood-down', endedAt: now, by: null })
      this.sink.withdraw([cueAlertId(cue.id)], [cue.target.id, cue.caller.id])
    }
    for (const panic of [...this.panics.values()]) {
      if (now - panic.at < PANIC_STALE_MS) continue
      this.end(panic, null, now)
      this.sink.systemMessage(panic.channelId, panicWords.lapsed(panic))
    }
  }

  /** Somebody's account is gone: their cues and calls go with it. */
  forget(userId: string): void {
    const now = this.now()
    for (const cue of [...this.cues.values()]) {
      if (cue.target.id !== userId && cue.caller.id !== userId) continue
      this.apply({ ...cue, state: 'stood-down', endedAt: now, by: null })
    }
    for (const panic of [...this.panics.values()]) {
      if (panic.person.id === userId) this.end(panic, null, now)
    }
  }
}
