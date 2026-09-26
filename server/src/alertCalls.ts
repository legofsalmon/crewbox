import type * as Y from 'yjs'
import {
  callAlert,
  callsDue,
  callsFor,
  countdownFor,
  movedCalls,
  wallClock,
  type Act,
  type Alert,
  type ChangeoverCall,
  type StageCountdown,
} from '@crewbox/shared'
import type { StageSource } from './alerts.ts'
import { readRunningOrder, TIMETABLE_ROOM } from './control.ts'

/**
 * Changeover calls and the lock-screen countdown, from the running order the
 * box already relays (docs/ALERTS.md).
 *
 * The box reads the running order off the shared document on a timer, with
 * the phones' own agenda maths and the festival's clock (`CREWBOX_TZ`), so a
 * call and the sidebar in a crew member's pocket agree on who is next. A
 * call is made once, in the tick its minute arrives in. A set that moves
 * withdraws the calls it no longer has and re-arms them at its new start,
 * because a call's id carries the start.
 */

/** How often the running order is read. Calls are to the minute, so four times one is plenty. */
export const CALLS_TICK_MS = 15_000

/** How long a call is kept for a catch-up. The catch-up itself takes only two minutes of them. */
const KEEP_CALLS_MS = 10 * 60_000

interface DocSource {
  peek(name: string): Y.Doc | null
}

/** Where calls and countdown changes go: the alerts socket. */
interface CallSink {
  onCall(alert: Alert): void
  withdraw(ids: string[], audience: string[] | null): void
  onStagesChanged(): void
}

export class StageCalls implements StageSource {
  private timer: NodeJS.Timeout | null = null
  /** Show day and minute the last tick reached, so each call fires in one tick only. */
  private reached: { day: string; now: number } | null = null
  private acts: Act[] = []
  private fingerprint = ''
  /** Every call made today, by id, so a clock that steps back never makes one twice. */
  private made = new Set<string>()
  private recent: Alert[] = []

  constructor(
    private readonly docs: DocSource,
    private readonly sink: CallSink,
    private readonly clock: () => Date = () => new Date(),
    /** The festival's zone, for calls, and for a phone that gave none. */
    private readonly timeZone?: string
  ) {}

  start(): void {
    if (this.timer) return
    this.tick()
    this.timer = setInterval(() => this.tick(), CALLS_TICK_MS)
    this.timer.unref()
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Read the running order and make whatever calls have come due. Public for tests. */
  tick(): void {
    const acts = readRunningOrder(this.docs.peek(TIMETABLE_ROOM))
    const now = this.clock()
    const wall = wallClock(now, this.timeZone)
    const fingerprint = JSON.stringify(acts)
    const changed = fingerprint !== this.fingerprint

    if (!this.reached || this.reached.day !== wall.today) {
      // A first tick, or a new show day: nothing already past is called late.
      this.reached = { day: wall.today, now: wall.now }
      this.made.clear()
    }

    if (changed && this.fingerprint !== '') {
      const before = callsFor(this.acts, wall.today)
      const after = new Set(callsFor(acts, wall.today).map((call) => call.id))
      // Calls the running order no longer has: a set that moved, or went.
      const gone = before
        .filter((call) => !after.has(call.id) && this.made.has(call.id))
        .map((call) => call.id)
      if (gone.length > 0) this.sink.withdraw(gone, null)
      for (const call of movedCalls(this.acts, acts, wall.today, wall.now)) this.make(call, now)
    }
    this.acts = acts
    this.fingerprint = fingerprint
    if (changed) this.sink.onStagesChanged()

    for (const call of callsDue(callsFor(acts, wall.today), this.reached.now, wall.now)) {
      this.make(call, now)
    }
    this.reached = { day: wall.today, now: wall.now }
    const keepFrom = now.getTime() - KEEP_CALLS_MS
    this.recent = this.recent.filter((alert) => alert.at > keepFrom)
  }

  private make(call: ChangeoverCall, now: Date): void {
    if (this.made.has(call.id)) return
    this.made.add(call.id)
    const alert = callAlert(call, now.getTime(), false)
    this.recent.push(alert)
    this.sink.onCall(alert)
  }

  recentCalls(since: number): Alert[] {
    return this.recent.filter((alert) => alert.at > since)
  }

  countdown(stages: string[], timeZone: string | undefined): StageCountdown[] {
    return countdownFor(this.acts, stages, this.clock(), timeZone ?? this.timeZone)
  }
}
