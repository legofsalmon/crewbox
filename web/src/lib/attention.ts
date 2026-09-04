/**
 * Is anybody actually looking at this window?
 *
 * Read receipts are the one piece of state the crew cannot repair. A cleared
 * badge is gone — there is no "mark unread" — so the bar for clearing one is
 * that somebody was in a position to have read the messages.
 *
 * The store already holds that line on the incoming-message path, and the
 * scroll handler went around it. Scrolls are not only fingers: the settle
 * loop after opening a channel, a search jump landing, a browser restoring
 * its own scroll position on reload, and an image finishing its decode and
 * shifting the layout all fire one. On a phone locked and dropped into a
 * pocket, or a laptop lid closed on the production desk, that reached the
 * bottom of a channel nobody had read and cleared its badge.
 *
 * Both halves matter. `hasFocus()` catches the backgrounded tab; `hidden`
 * catches the phone whose screen is off, where the page is still its
 * window's focused document and `hasFocus()` happily returns true.
 */
export const looking = (doc: { hasFocus(): boolean; hidden: boolean }): boolean =>
  doc.hasFocus() && !doc.hidden
