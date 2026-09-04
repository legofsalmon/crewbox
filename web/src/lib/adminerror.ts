import { ApiError } from './api.ts'
import { useStore } from '../store.ts'

/**
 * What to show when an admin request fails, and what a 403 means.
 *
 * Admin unlocks live in one process's memory, so the box stops honouring one
 * whenever it restarts — which the box does by itself after an update, and
 * which somebody does by hand more often than that. Expiry and another admin
 * changing the password do the same.
 *
 * The store's own comment said any 403 gave the unlock back. Nothing did.
 * Every row in the panel caught the error, printed the server's message, and
 * left the dead token in place — so every button after that failed the same
 * way, with the panel still on screen and no route back to the password box
 * short of reloading the page. At two in the morning that reads as a broken
 * box rather than as a lock.
 */
export function adminError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) {
    const reason = 'The box stopped accepting the unlock — it may have restarted.'
    useStore.getState().adminUnlockLost(reason)
    return reason
  }
  return err instanceof ApiError ? err.message : fallback
}
