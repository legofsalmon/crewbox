import { VIDEO_INTENT_TTL_MS, newId, type VideoAction, type VideoIntent } from '@crewbox/shared'

/**
 * The double confirmation, as two requests rather than two dialogs.
 *
 * Asking to transmit and transmitting are separate calls. The first answers
 * with a description of exactly what would go on the wire and a single-use
 * token; nothing is sent until that token comes back on a second request.
 *
 * Doing it here rather than in the pane is the whole point. A confirm dialog
 * is a property of one screen — it protects the person looking at it and
 * nobody else. This protects the network: there is no single call, however
 * it is made, that puts a packet on a video network. Not a mistyped curl,
 * not a replayed request, not a script that got hold of an admin token and
 * knows the endpoint. It has to ask what will happen, be told, and come back.
 *
 * Intents are bound to the admin who raised them, single-use, and expire, so
 * one cannot be raised at load-in and spent at midnight by somebody else.
 */

interface StoredIntent extends VideoIntent {
  /** Whose intent this is. A different admin's token is not a confirmation. */
  userId: string
}

/**
 * Most intents held at once.
 *
 * They expire on their own, but an admin session that raised one per second
 * and never spent them would otherwise grow this map without limit. Well
 * above any real use: an admin arms one thing at a time.
 */
export const MAX_OPEN_INTENTS = 32

export class Intents {
  private readonly open = new Map<string, StoredIntent>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /**
   * Raise an intent. Returns what will be sent, for the admin to read before
   * they accept it — `willSend` is written for somebody who may have to
   * justify it to a venue's network manager.
   */
  arm(input: {
    userId: string
    action: VideoAction
    processorId?: string
    target: string
    willSend: string[]
  }): VideoIntent {
    this.sweep()
    // Raising a second intent replaces this admin's first for the same
    // action: the description they are looking at is the one that counts, and
    // two live tokens for one button is a way to spend the wrong one.
    for (const [token, held] of this.open) {
      if (held.userId === input.userId && held.action === input.action) this.open.delete(token)
    }
    if (this.open.size >= MAX_OPEN_INTENTS) {
      const oldest = [...this.open.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
      if (oldest) this.open.delete(oldest[0])
    }

    const intent: StoredIntent = {
      token: newId(),
      userId: input.userId,
      action: input.action,
      ...(input.processorId ? { processorId: input.processorId } : {}),
      target: input.target,
      willSend: input.willSend,
      expiresAt: this.now() + VIDEO_INTENT_TTL_MS,
    }
    this.open.set(intent.token, intent)
    const { userId: _userId, ...published } = intent
    return published
  }

  /**
   * Spend an intent, or say why it cannot be spent.
   *
   * The action and processor have to match what was described, so an intent
   * raised to scan cannot be spent to start watching something — otherwise
   * the description an admin read would not be the thing they authorised.
   */
  consume(input: {
    token: string | undefined
    userId: string
    action: VideoAction
    processorId?: string
  }): { ok: true; intent: VideoIntent } | { ok: false; reason: string } {
    this.sweep()
    if (!input.token) return { ok: false, reason: 'this needs confirming first' }
    const held = this.open.get(input.token)
    if (!held) return { ok: false, reason: 'that confirmation has expired — start again' }
    if (held.userId !== input.userId) {
      return { ok: false, reason: 'that confirmation belongs to somebody else' }
    }
    if (held.action !== input.action || held.processorId !== input.processorId) {
      return { ok: false, reason: 'that confirmation was for something else' }
    }
    // Single use, spent whether or not what follows succeeds. A retry is a
    // new decision.
    this.open.delete(input.token)
    const { userId: _userId, ...published } = held
    return { ok: true, intent: published }
  }

  private sweep(): void {
    const now = this.now()
    for (const [token, held] of this.open) {
      if (held.expiresAt <= now) this.open.delete(token)
    }
  }
}
