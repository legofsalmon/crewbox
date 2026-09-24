/**
 * Take the person out of a crash report, on the box, before it is queued.
 *
 * The contract every LeTissier app codes to (the letissier.ie intake) says a
 * report never carries a user name, a document path, an address of another
 * device on the network or anything after `?` in a URL. A stack trace carries
 * all of those by accident: the home directory is in every path, an error from
 * a lighting node names its IP, and a failed request prints its URL with the
 * session token still in the query string.
 *
 * Done here rather than on the server because the point is that it never
 * leaves the machine. Deliberately blunt: a trace that loses a harmless
 * address is still a useful trace; a trace that keeps a real one is a leak.
 */

export interface ScrubContext {
  /** The home directory to fold to `~`, e.g. `/Users/sam`. */
  home?: string
  /** The login name, removed wherever it appears as a path segment. */
  user?: string
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Anything after `?` in a URL goes, fragment included. */
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>)]*)[?#][^\s"'<>)]*/gi

/** Home directories of anybody, not only this user: `/Users/x`, `/home/x`, `C:\Users\x`. */
const ANY_HOME = /(\/Users\/|\/home\/|[A-Za-z]:\\Users\\|[A-Za-z]:\/Users\/)[^/\\\s:'")]+/g

/**
 * An IPv4 address. Four dotted groups, so a version such as `1.0.0` or a
 * `file.ts:12:34` position is never mistaken for one.
 */
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

/**
 * An IPv6 address: eight full groups, or a compressed one with `::` and at
 * least one group. Never touches a `file.ts:12:34` position, which has no
 * `::` and fewer than seven colons.
 */
const IPV6 =
  /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?=[0-9a-f:]*[0-9a-f])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?![\w:])/gi

/** Email addresses — an error message can quote one a person typed. */
const EMAIL =
  /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g

/**
 * Scrub one piece of text.
 *
 * Order matters: URLs first, so a query string holding a path or an address
 * goes as a whole; then this user's home, so their own paths read `~/...`
 * rather than `/Users/<user>/...`; then everybody else's.
 */
export function scrub(text: string, context: ScrubContext = {}): string {
  let out = text.replace(URL_QUERY, '$1')

  const home = context.home?.replace(/[\\/]+$/, '')
  if (home && home.length > 1) {
    // Both slash directions: Node reports Windows paths with backslashes, a
    // browser or a file:// URL with forward ones. Case-insensitive, because
    // Windows and macOS both are.
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])
    for (const variant of variants) {
      out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), '~')
    }
  }

  out = out.replace(ANY_HOME, '$1<user>')

  const user = context.user?.trim()
  // Three characters or more: a one-letter login would eat every `a/` in a
  // trace, and the home-directory pass above has already done the real work.
  if (user && user.length >= 3) {
    out = out.replace(
      new RegExp(`(^|[\\\\/])${escapeRegExp(user)}(?=[\\\\/]|$)`, 'gim'),
      '$1<user>'
    )
  }

  return out.replace(EMAIL, '<email>').replace(IPV4, '<ip>').replace(IPV6, '<ip>')
}

/**
 * Cut a string to `max` characters without splitting a surrogate pair — an
 * emoji half-cut is an invalid string that some JSON parsers refuse.
 */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value
  let end = max
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return value.slice(0, end)
}
