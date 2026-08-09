/**
 * The small HTTP responder that stops a phone giving up on the crew Wi-Fi.
 *
 * Every phone OS decides for itself whether a network "has internet", and it
 * does that by fetching one fixed URL over plain HTTP the moment it joins:
 * iOS and macOS ask captive.apple.com for hotspot-detect.html and want a 200
 * whose body says Success; Android asks for generate_204 and wants exactly a
 * 204; Windows wants a two-word text file. A crew network with no uplink
 * fails all of them.
 *
 * What happens next is the part that costs a show. iOS does not merely draw a
 * warning triangle — it drops the Wi-Fi indicator and quietly routes traffic
 * over cellular, so the crew box (a private address, reachable only over the
 * Wi-Fi that was just abandoned) becomes unreachable. The phone is still
 * associated. The app is still installed. It just cannot see the box, and the
 * banner says "Connecting" forever. That is the exact failure a real event hit,
 * and every iPhone with signal will do the same thing.
 *
 * So the box answers the probes itself. Two halves are needed and both are
 * opt-in in the right way:
 *
 *  - This listener, on port 80, bound to the crew adapter only — it never
 *    appears on the lighting VLAN, and if it cannot have port 80 it says why
 *    and the box carries on without it.
 *  - DNS on the event router pointing the probe hostnames at the box. That
 *    part an admin pastes deliberately (see dnsconfig.ts), which is why
 *    running this listener on its own changes nothing: with no DNS record,
 *    no probe ever arrives here.
 *
 * The honest trade: once both halves are in place, phones stop warning that
 * the crew network has no internet — because as far as they can tell, it
 * has. That is the point. Crew on this network are not browsing; they are
 * talking to the box, and a phone that thinks it should go to cellular for
 * that is a phone with no comms.
 */

import { createServer, type Server } from 'node:http'

/** Apple wants this verbatim; it looks for `Success` in the body. */
const APPLE_SUCCESS = '<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>\n'

/**
 * Hostnames worth pointing at the box, and deliberately no more.
 *
 * Each of these exists only to be probed, so intercepting it costs a phone
 * nothing else. The near misses left out on purpose:
 *
 *  - `www.gstatic.com` and `www.google.com` serve real content as well as
 *    gen_204, so hijacking them breaks pages rather than fixing a network.
 *  - `dns.msftncsi.com` is a *DNS* probe: Windows resolves it and checks the
 *    answer is 131.107.255.255. Point it at the box and Windows concludes
 *    the opposite of what we want.
 */
export const PROBE_HOSTS = [
  // iOS, iPadOS, macOS, tvOS.
  'captive.apple.com',
  // Android and ChromeOS. Modern Android tries the gstatic one first.
  'connectivitycheck.gstatic.com',
  'connectivitycheck.android.com',
  'clients3.google.com',
  // Windows 10/11 (NCSI).
  'www.msftconnecttest.com',
  // Firefox's own captive-portal check, on every platform.
  'detectportal.firefox.com',
] as const

export interface CaptiveReply {
  status: number
  /** Absent on a 204 and on a redirect. */
  type?: string
  body?: string
  /** Set on a redirect; always the box's own origin, never anything requested. */
  location?: string
}

/**
 * What to answer for a probe path.
 *
 * Kept pure and separate from the listener because the bodies are the whole
 * feature: a byte wrong here and the phone decides the network is captive,
 * pops a sign-in sheet crew cannot complete, and gives up exactly as before.
 *
 * `origin` is computed by the caller from the box's own certificate name and
 * port. It is never derived from the request, so this cannot be turned into
 * an open redirector by anyone who can reach port 80.
 */
export function captiveResponse(url: string, origin: string): CaptiveReply {
  // Probes never send a query string, but a browser typing the box name might.
  const path = (url.split('?')[0] ?? '').split('#')[0]?.toLowerCase() ?? ''

  switch (path) {
    // Apple. hotspot-detect.html is the live one; success.html is the older
    // path still used by some macOS releases and by tvOS.
    case '/hotspot-detect.html':
    case '/library/test/success.html':
      return { status: 200, type: 'text/html', body: APPLE_SUCCESS }

    // Android/ChromeOS. The body must be empty — a 204 with content is a
    // protocol error, and Android treats anything but a bare 204 as a portal.
    case '/generate_204':
    case '/gen_204':
      return { status: 204 }

    // Windows NCSI. Both strings are exact; Windows compares them literally.
    case '/connecttest.txt':
      return { status: 200, type: 'text/plain', body: 'Microsoft Connect Test' }
    case '/ncsi.txt':
      return { status: 200, type: 'text/plain', body: 'Microsoft NCSI' }

    // Firefox.
    case '/success.txt':
      return { status: 200, type: 'text/plain', body: 'success\n' }

    default:
      // Everything else is a person, not a probe — most often someone typing
      // the box's name into Safari, which defaults to http:// and would
      // otherwise get a connection refused. Send them to the real origin.
      return { status: 302, location: origin }
  }
}

export interface CaptivePortal {
  /** The port it actually got — 80 unless CREWBOX_CAPTIVE_PORT said otherwise. */
  port: number
  close(): Promise<void>
}

export interface CaptiveResult {
  portal?: CaptivePortal
  /** Why there is no responder, when there isn't. Shown to the admin verbatim. */
  reason?: string
}

/** The fix for a privileged port, which is different on every platform. */
function privilegedPortFix(port: number): string {
  if (process.platform === 'linux') {
    return (
      `Only root may bind port ${port}. Either grant the binary the capability once ` +
      "(sudo setcap 'cap_net_bind_service=+ep' /path/to/crewbox), or set " +
      'CREWBOX_CAPTIVE_PORT to an unprivileged port and redirect 80 to it on the router.'
    )
  }
  if (process.platform === 'darwin') {
    return (
      `Only root may bind port ${port} on macOS. Set CREWBOX_CAPTIVE_PORT to an ` +
      'unprivileged port (say 8080) and have the event router redirect port 80 to it, ' +
      'or run the box with sudo.'
    )
  }
  return `This account may not bind port ${port}. Set CREWBOX_CAPTIVE_PORT to an unprivileged port instead.`
}

/**
 * Start the responder, or explain why not.
 *
 * Never throws and never stops the box: a crew network without this is the
 * network crewbox has always shipped, so the failure is a line in the admin
 * panel, exactly like a missing certificate.
 */
export function startCaptive(opts: {
  /** Same address the main server binds — the crew adapter, or 0.0.0.0. */
  host: string
  port: number
  /** Where a browser gets sent. Computed by the caller; never from a request. */
  origin: string
}): Promise<CaptiveResult> {
  const server: Server = createServer((req, res) => {
    // GET and HEAD only. Nothing here has a side effect, and a responder that
    // answered POST would be a slightly larger surface for no gain at all.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }

    const reply = captiveResponse(req.url ?? '/', opts.origin)
    const headers: Record<string, string> = {
      // Probes are re-run whenever the OS feels like it, and a cached
      // Success would outlive the network it was true for.
      'cache-control': 'no-store',
    }
    if (reply.type) headers['content-type'] = `${reply.type}; charset=utf-8`
    if (reply.location) headers['location'] = reply.location
    if (reply.body !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(reply.body))
    }
    res.writeHead(reply.status, headers)
    res.end(req.method === 'HEAD' ? undefined : reply.body)
  })

  // A probe that arrives while the phone is deciding must not sit on a
  // half-open socket; the OS gives up long before Node's default would.
  server.keepAliveTimeout = 2000
  server.headersTimeout = 5000

  return new Promise<CaptiveResult>((resolve) => {
    const fail = (err: NodeJS.ErrnoException) => {
      server.close()
      if (err.code === 'EACCES') {
        resolve({ reason: privilegedPortFix(opts.port) })
      } else if (err.code === 'EADDRINUSE') {
        resolve({
          reason:
            `Something else is already listening on port ${opts.port}. Stop it, or set ` +
            'CREWBOX_CAPTIVE_PORT to a free port and redirect 80 to it on the router.',
        })
      } else {
        resolve({ reason: `Could not listen on port ${opts.port}: ${err.message}` })
      }
    }
    server.once('error', fail)
    server.listen(opts.port, opts.host, () => {
      server.removeListener('error', fail)
      const address = server.address()
      resolve({
        portal: {
          port: typeof address === 'object' && address ? address.port : opts.port,
          close: () => new Promise<void>((done) => server.close(() => done())),
        },
      })
    })
  })
}
