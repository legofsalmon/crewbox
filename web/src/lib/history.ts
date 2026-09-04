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
}): number | null {
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
