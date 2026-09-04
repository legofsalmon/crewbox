import type { Message } from '@crewbox/shared'

/**
 * How much of a channel's transcript stays in memory once you leave it.
 *
 * The 300-per-channel cap was only ever the *cache's*: the in-memory array
 * and the `MessageRow` per message it renders grew for the whole shift, so a
 * phone that had #general open through a festival Saturday was holding
 * thousands of message objects and as many DOM rows, on a device chosen for
 * being cheap enough to lose.
 *
 * The channel on screen is left alone — trimming above the viewport would
 * move the scroll under somebody's thumb — so this bites when they move on,
 * and `loadOlder` reads the cache before the box, which makes coming back
 * and scrolling up free.
 */
export const KEEP_IN_MEMORY = 500

/**
 * Trim a channel's tail.
 *
 * Returns the same array when there is nothing to drop: this runs for every
 * channel on every arriving message, and handing back a new array each time
 * would re-render all of them to save nothing.
 */
export function capTranscript(messages: Message[], keep = KEEP_IN_MEMORY): Message[] {
  return messages.length > keep ? messages.slice(messages.length - keep) : messages
}
