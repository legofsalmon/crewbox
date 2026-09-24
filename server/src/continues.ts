import type { Store } from './store.ts'

/**
 * The event this box carries on, as an admin said in Admin → This box.
 *
 * A spare with no backup, or a bigger box brought in mid-event, starts with a
 * database of its own, so to every phone it is another event: they send it
 * nothing of the one they had, and keep that one's work apart
 * (docs/DISCOVERY.md). An admin who knows it carries on that event says so
 * here, and each phone holding the event offers, once its crew member has
 * joined this box, to bring its work across.
 *
 * The admin's word, and not a proof. Only the old event's own database could
 * sign for it, and it is on the box that has gone. So a phone asks rather
 * than moves anything, and only once its crew member has joined this box.
 */
export interface Continues {
  /** The event's ID, as its own box gave it (`PublicConfig.eventId`). */
  id: string
  /** Its name, as the admin's device knew it; '' when it had none. */
  name: string
}

/**
 * Where it is kept, in the settings table. A storage name on every box that
 * has saved it: renaming it strands the answer on those boxes.
 */
export const CONTINUES_KEY = 'continues'

/** An event ID as a phone takes one (web/src/lib/eventScope.ts `eventIdFrom`). */
export const EVENT_ID = /^[0-9A-Za-z_]{1,64}$/

/** The event this box carries on, or null: none said, cleared, or unreadable. */
export function continuesOf(store: Store): Continues | null {
  const saved = store.getSetting(CONTINUES_KEY)
  if (!saved) return null
  try {
    const value = JSON.parse(saved) as Partial<Continues>
    if (typeof value.id !== 'string' || !EVENT_ID.test(value.id)) return null
    return { id: value.id, name: typeof value.name === 'string' ? value.name : '' }
  } catch {
    return null
  }
}

/** Keep an admin's answer; null clears it. */
export function saveContinues(store: Store, value: Continues | null): void {
  store.setSetting(CONTINUES_KEY, value ? JSON.stringify(value) : '')
}
