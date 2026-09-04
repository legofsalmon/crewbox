/**
 * When a document's local copy is ready — or has proved it never will be.
 *
 * `IndexeddbPersistence.whenSynced` resolves when the 'synced' event fires
 * and **never rejects**: a browser that has IndexedDB and refuses to open it
 * — a corrupted profile, a private window, a quota that has run out — leaves
 * that promise pending for the life of the tab. Both call sites had a
 * rejection handler on it and a comment saying it "resolves either way",
 * and neither was true: the handler could not run, so a pane awaiting it sat
 * on "Loading sheet…" for ever. The failed open was also an unhandled
 * rejection on the library's own `_db`, once per document.
 *
 * The open is the thing to watch. It rejects when there is no local copy to
 * wait for, in which case there is nothing to wait for; it resolves when
 * there is, and then 'synced' is the honest signal. The timeout is for the
 * third case nobody can enumerate — an open that succeeds and a read that
 * wedges — because a document that is on the relay is still perfectly
 * usable, and persistence is an accelerator.
 */

/** The parts of `IndexeddbPersistence` that answer the question. */
export interface LocalCopy {
  whenSynced: Promise<unknown>
  /**
   * The library's own open promise. Private by name and public in its type
   * declaration, and the only place a failed open is observable.
   */
  _db: Promise<unknown>
}

/** Long enough that a real read is never cut short on a slow phone. */
export const LOAD_TIMEOUT_MS = 10_000

export function whenPersisted(local: LocalCopy | null, timeoutMs = LOAD_TIMEOUT_MS): Promise<void> {
  if (!local) return Promise.resolve()
  const ready = local._db.then(
    () => local.whenSynced.then(() => undefined),
    () => undefined
  )
  return Promise.race([ready, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
}
