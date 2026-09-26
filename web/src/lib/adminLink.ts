import { adminUnlockWithLink, ApiError } from './api.ts'

/**
 * The page's half of the admin link (server/src/adminLink.ts).
 *
 * "Open the admin panel" in the box's own menu, and `crewbox --admin`, open
 * `/?admin#admin-key=…`. The key is good once, for whoever is at the box: it
 * lives in a file only the box's own user can read.
 *
 * It is taken out of the address bar before anything else runs, and spent
 * straight away rather than when the panel opens. On a browser that has not
 * joined yet that is a whole join form later, and a key still waiting to be
 * used is a key sitting in the browser's history. Spent, the history holds a
 * dead one; the token that comes back waits here, in memory, like any other
 * unlock.
 */

/** The fragment parameter the box's link puts its key in. */
export const ADMIN_KEY_PARAM = 'admin-key'

/** What the box made of the key, once it has answered. */
export type AdminLinkOutcome = { adminToken: string } | { problem: string }

let pending: Promise<AdminLinkOutcome> | null = null

/**
 * The key from the address bar, which is left without it. Null when the page
 * was not opened from an admin link.
 *
 * Anything else in the fragment stays, and so do the path and the query:
 * `?admin` is what opens the panel, and is taken by the code that does.
 */
export function takeAdminKey(
  where: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location,
  history: Pick<History, 'replaceState' | 'state'> = window.history
): string | null {
  const fragment = new URLSearchParams(where.hash.replace(/^#/, ''))
  const key = fragment.get(ADMIN_KEY_PARAM)
  if (!key) return null
  fragment.delete(ADMIN_KEY_PARAM)
  const rest = fragment.toString()
  history.replaceState(
    history.state,
    '',
    `${where.pathname}${where.search}${rest ? `#${rest}` : ''}`
  )
  return key
}

/**
 * Take the key, if this page came with one, and spend it. Called once, as
 * the page starts, before anything can rewrite the address.
 */
export function redeemAdminLink(
  key: string | null = takeAdminKey(),
  unlock: (key: string) => Promise<{ adminToken: string }> = adminUnlockWithLink
): void {
  if (!key) return
  pending = unlock(key).then(
    ({ adminToken }) => ({ adminToken }),
    (err: unknown) => ({
      problem:
        err instanceof ApiError
          ? err.message
          : 'Could not reach the box to use the admin link. Open it again from the Crewbox menu.',
    })
  )
}

/**
 * The answer, for whoever opens the panel, once. Null when this page came
 * without a link, or it has already been handed over.
 */
export function takeAdminLinkOutcome(): Promise<AdminLinkOutcome> | null {
  const outcome = pending
  pending = null
  return outcome
}
