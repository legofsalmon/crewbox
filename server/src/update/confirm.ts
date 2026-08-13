import { newId } from '@crewbox/shared'
import type { Interruption } from './guard.ts'

/**
 * The double confirmation for installing, as two requests rather than a
 * dialog.
 *
 * Same shape as the video module's `Intents`, and for the same reason: asking
 * what will happen and doing it are separate calls, so there is no single
 * request — however it is made, by whatever script got hold of an admin token
 * — that takes a box off the air. It has to ask, be told exactly what is
 * about to be interrupted, and come back with the answer.
 *
 * **Deliberately not shared with `video/intents.ts` yet.** The two carry
 * different payloads and describe different things, and the video sweep is
 * shipped, security-sensitive code. Two instances is not a pattern; if a
 * third caller turns up, that is the moment to extract one properly rather
 * than to couple this to it now for the sake of a line count.
 */

/** Long enough to read the warning and think; short enough not to be banked. */
export const INSTALL_INTENT_TTL_MS = 2 * 60 * 1000

export interface InstallIntent {
  token: string
  /** The version this confirmation is for. */
  version: string
  /** What the admin was shown before they accepted. */
  interruption: Interruption
  expiresAt: number
}

interface Held extends InstallIntent {
  /** Whose intent this is. Another admin's token is not a confirmation. */
  userId: string
}

export class InstallConfirmations {
  private held: Held | null = null

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Raise one, replacing whatever this box was holding.
   *
   * Only ever one at a time, unlike the video module's map: there is exactly
   * one box and it can only be updated to one version at once, so a second
   * intent is always a correction of the first rather than a parallel
   * decision.
   */
  arm(input: { userId: string; version: string; interruption: Interruption }): InstallIntent {
    const intent: Held = {
      token: newId(),
      userId: input.userId,
      version: input.version,
      interruption: input.interruption,
      expiresAt: this.now() + INSTALL_INTENT_TTL_MS,
    }
    this.held = intent
    const { userId: _userId, ...published } = intent
    return published
  }

  /**
   * Spend it, or say why it cannot be spent.
   *
   * The version has to match what was described. An intent raised against
   * v0.18.0 must not install v0.19.0 that appeared in between — otherwise the
   * warning somebody read was about a different thing than the one they
   * authorised.
   */
  consume(input: {
    token: string | undefined
    userId: string
    version: string
  }): { ok: true; intent: InstallIntent } | { ok: false; reason: string } {
    const held = this.held
    if (!input.token) return { ok: false, reason: 'this needs confirming first' }
    if (!held) return { ok: false, reason: 'that confirmation has expired — start again' }
    if (held.expiresAt <= this.now()) {
      this.held = null
      return { ok: false, reason: 'that confirmation has expired — start again' }
    }
    if (held.token !== input.token) {
      return { ok: false, reason: 'that confirmation has expired — start again' }
    }
    if (held.userId !== input.userId) {
      return { ok: false, reason: 'that confirmation belongs to somebody else' }
    }
    if (held.version !== input.version) {
      return { ok: false, reason: `that confirmation was for ${held.version}` }
    }
    // Single use, spent whether or not the install then works. A retry is a
    // new decision, taken against a fresh reading of what is on.
    this.held = null
    const { userId: _userId, ...published } = held
    return { ok: true, intent: published }
  }

  /** Drop anything held. Used when the flow moves on underneath it. */
  clear(): void {
    this.held = null
  }
}
