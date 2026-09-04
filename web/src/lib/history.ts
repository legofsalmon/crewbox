/**
 * Where to page a channel's scrollback from.
 *
 * The box bounds the whole welcome with a global budget — twenty channels at
 * two hundred messages each, stringified on the event loop and pushed over
 * festival Wi-Fi to a hundred phones that all re-helloed when an access point
 * blipped, is not a frame anybody wants to send. Whatever does not fit comes
 * back named in `truncated`, and the hub's comment says the client backfills
 * those over REST.
 *
 * No such code existed, and the second half of the gap was here: paging
 * backwards needs a message to page back *from*, and a truncated channel that
 * got nothing has none. So the channel that most needed history was the one
 * that refused to fetch any, and it sat reading "No messages yet" with an
 * unread badge beside it until somebody posted something new.
 */

/**
 * The `beforeSeq` to ask for, or null when there is nothing older to want.
 *
 * `lastSeq` is what the channel says it holds, which is knowable without
 * holding any of it — that is the whole point. Asking for `lastSeq + 1` gets
 * the newest page, which is what a phone with nothing needs first.
 */
export function pageFrom(input: {
  earliestSeq?: number | undefined
  lastSeq: number
  /**
   * A previous page came back empty, so there is provably nothing older.
   *
   * Needed because `seq > 1` is not the same question. Deleting a
   * channel's first message makes the oldest held seq 2 for ever, so the
   * scroll handler asked, got nothing, and asked again on the very next
   * scroll event — for the life of the session, on the channel somebody
   * was reading.
   */
  exhausted?: boolean
}): number | null {
  if (input.exhausted) return null
  // Something held: page back from the oldest of it. Seq 1 is the first
  // message there has ever been, so holding it means there is no older.
  if (input.earliestSeq !== undefined) {
    return input.earliestSeq > 1 ? input.earliestSeq : null
  }
  // Nothing held. An empty channel and a channel this phone has simply not
  // been sent yet look identical from here — `lastSeq` is what tells them
  // apart, and it comes down in every welcome.
  return input.lastSeq > 0 ? input.lastSeq + 1 : null
}

/**
 * Which truncated channels this phone holds nothing at all for.
 *
 * A channel that was truncated but still got its tail is fine: it has
 * something on screen and `loadOlder` pages back from it when somebody
 * scrolls. The ones worth a request now are the channels the budget ran out
 * before reaching, because there is nothing there to scroll.
 */
export function needsBackfill(
  truncated: readonly string[],
  messages: Record<string, { length: number } | undefined>
): string[] {
  return truncated.filter((id) => !messages[id]?.length)
}

/**
 * Is this the same database the cache was built against?
 *
 * A resume cursor is a bare sequence number, and sequence numbers come from
 * `MAX(seq)` over live rows — so restoring a backup, or swapping to the spare
 * box, starts the count below every phone's cursor. The box then had nothing
 * to say and the crew heard nothing, for as long as it took the counter to
 * climb past a number nobody could see.
 *
 * The cached messages go with the cursors, because they are numbered against
 * a database that is not here any more and two messages at the same seq are
 * two different messages. The outbox does not: what somebody typed is theirs,
 * and the box dedupes the replay by client id.
 *
 * Only a *changed* epoch resets anything. A phone that has never seen one —
 * a first connection, or a box too old to send it — keeps what it has, which
 * is the behaviour that was always right.
 */
export function databaseChanged(seen: string | null, offered: string | undefined): boolean {
  if (!offered || !seen) return false
  return seen !== offered
}

/**
 * Whether a page of older messages is safe to write to the durable cache.
 *
 * Not while the view is gapped. A search jump puts a detached block on
 * screen — messages around seq 400 with nothing between them and the
 * cached tail — and paging older from there fetches a block contiguous
 * with the *jump*, not with anything cached. Writing it leaves a permanent
 * hole: after a reload the channel reads 1-50, 380-420, 900-1000, with
 * nothing saying anything is missing and no scroll that will ever fill it.
 * On screen the block is still there and still useful; it is only the copy
 * that outlives the session that has to stay honest.
 */
export const cacheable = (gapped: boolean): boolean => !gapped
