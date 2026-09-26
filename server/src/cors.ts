/**
 * Which pages may read the box's answers from another origin.
 *
 * The apps load the web app from their own package, so everything they ask
 * their box comes from another origin: `http://localhost` in the Android app
 * (`androidScheme` in native/capacitor.config.ts), `capacitor://localhost` on
 * the iPhone. A browser at the box's own address never needs this: its
 * requests are its own origin's, and a browser doesn't ask about those.
 *
 * The box used to answer every origin. Sign-ins are bearer tokens and there
 * are no cookies, so no other website could act as anybody. But the box
 * shows some things to whoever reaches it on its own network: the event PIN
 * on /connect, and on a box nobody has set up yet, the admin password it
 * minted, on /setup. A page open in a crew member's browser is on that
 * network, so any website could read them through it, and with the PIN join
 * the crew and read its channels.
 *
 * So the box answers two kinds of origin, and no other:
 *
 * - This device's loopback, on any port: `localhost`, 127.x.x.x or [::1], by
 *   a web view's scheme or a local server's. That is both apps, and a
 *   developer's own server, the end-to-end suite's included. No website can
 *   have one of these origins.
 * - Any origin at all, on the desk control API (control.ts). It answers
 *   nothing without its key, and it is documented for anything that can make
 *   a request, which includes a page.
 *
 * Anything else, `null` included (a sandboxed frame's, which any page can
 * make), gets no CORS headers. Its browser still sends a simple request,
 * which the box can't prevent, but doesn't show the page the answer, and
 * sends nothing that has to ask first.
 *
 * This doesn't stop DNS rebinding: a site whose name has been pointed at the
 * box is the box's own origin to its browser, which asks nothing. That
 * would take refusing a Host header that isn't one of the box's names, and
 * the box answers to more names than it knows (a tunnel's, a proxy's).
 */

/** The schemes a page on this device's loopback has: a web view's, or a local server's. */
const LOOPBACK_SCHEMES = new Set(['http:', 'https:', 'capacitor:'])

/** The desk control API's routes, each of which checks its key before it says anything. */
const CONTROL_PREFIX = '/api/control/'

/** Whether `origin` is a page served on the device that sent it. */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (!LOOPBACK_SCHEMES.has(url.protocol)) return false
  const host = url.hostname
  return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/**
 * Whether the box answers a request from `origin` for `url`, the path and
 * query it asked for, with CORS headers. A request with no origin is no
 * browser's cross-origin request, so it needs none.
 */
export function allowsOrigin(origin: string | undefined, url: string): boolean {
  if (!origin) return false
  return url.startsWith(CONTROL_PREFIX) || isLoopbackOrigin(origin)
}
