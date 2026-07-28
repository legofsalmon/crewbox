import type { Message } from '@crewbox/shared'

/**
 * Filtering and link detection for a channel's transcript.
 *
 * Kept out of the components because both need the same answers: the filter
 * bar asks "does this message have a link in it", and the renderer asks "where
 * are the links so I can make them clickable". Two regexes would drift, and
 * the drift would show as a message that the Links filter finds but does not
 * render as a link.
 */

/**
 * A URL in message text.
 *
 * Deliberately conservative. Crew paste addresses into chat mid-shift, often
 * with a full stop after them, and a greedy match that swallows the sentence's
 * punctuation produces a dead link. So: match the scheme (or a bare www.),
 * take everything that is not whitespace or a closing bracket, then let
 * `trimUrl` give back any trailing punctuation.
 */
export const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()[\]]+/gi

/** Sentence punctuation that a URL at the end of a sentence should not eat. */
const TRAILING = /[.,;:!?'"]+$/

/** The URL without whatever punctuation ended the sentence it sat in. */
export function trimUrl(raw: string): string {
  return raw.replace(TRAILING, '')
}

/**
 * Where to actually send someone. A bare "www.example.com" has no scheme, and
 * an href without one is resolved as a *relative path* — which on this app
 * would navigate to a route inside the box rather than out to the web.
 */
export function hrefFor(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

/** Does this message body contain a link? */
export function hasLink(body: string): boolean {
  URL_RE.lastIndex = 0
  return URL_RE.test(body)
}

/** Split a run of text into plain parts and links, in order. */
export function splitLinks(text: string): Array<{ text: string; url?: string }> {
  const out: Array<{ text: string; url?: string }> = []
  let cursor = 0
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0]
    const url = trimUrl(raw)
    // The punctuation `trimUrl` removed belongs to the sentence, not the link.
    const tail = raw.slice(url.length)
    if (match.index > cursor) out.push({ text: text.slice(cursor, match.index) })
    out.push({ text: url, url })
    if (tail) out.push({ text: tail })
    cursor = match.index + raw.length
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) })
  return out
}

/** What a channel's filter bar can narrow to. */
export type MessageKindFilter = 'all' | 'media' | 'files' | 'links' | 'mentions'

export interface MessageFilter {
  /** Author id, or null for everyone. */
  authorId: string | null
  kind: MessageKindFilter
}

export const NO_FILTER: MessageFilter = { authorId: null, kind: 'all' }

export const isFiltering = (filter: MessageFilter): boolean =>
  filter.authorId !== null || filter.kind !== 'all'

/** True when the body mentions `myName`, @all, @everyone or @channel. */
export function mentionsMe(body: string, myName: string | undefined): boolean {
  const lower = body.toLowerCase()
  if (/@(all|everyone|channel)\b/.test(lower)) return true
  if (!myName) return false
  return lower.includes(`@${myName.toLowerCase()}`)
}

export function matchesFilter(
  message: Message,
  filter: MessageFilter,
  myName: string | undefined
): boolean {
  // System messages are the channel talking about itself — "X joined". They
  // are never what someone is looking for when they filter, and leaving them
  // in makes a filtered view look like it failed to filter.
  if (message.kind === 'system') return !isFiltering(filter)

  if (filter.authorId !== null && message.authorId !== filter.authorId) return false

  switch (filter.kind) {
    case 'all':
      return true
    case 'media':
      // Photos of the rig, mostly. Video too — anything you would look at
      // rather than open.
      return Boolean(message.file && /^(image|video)\//i.test(message.file.mime))
    case 'files':
      return Boolean(message.file)
    case 'links':
      return hasLink(message.body)
    case 'mentions':
      return mentionsMe(message.body, myName)
  }
}
