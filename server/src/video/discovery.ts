import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { DISCOVERY_PORT, isIpv4 } from '@crewbox/shared'

/**
 * The one scan, and only when an admin has confirmed it twice.
 *
 * NovaLCT finds controllers by broadcasting eight ASCII bytes, `rqProMI:`, on
 * UDP 3800 and reading what answers. That is what this does, once, on demand.
 *
 * **COEX controllers don't answer it** — an MX40 Pro and an MX30 both ignored
 * eight probes each (OBSERVED) — so the same listening window also hears the
 * other way a controller can be found: an MX30 **announces itself** every
 * 3.0 s, unsolicited, to the subnet broadcast on UDP 54622, 54623, 54624 and
 * 54700 (OBSERVED, one unit, V1.5.1). That half transmits nothing, and it is
 * how VMP finds an MX30: it sent no probe at all, and connected 5 ms after an
 * announcement. Whether an MX40 Pro announces is UNKNOWN.
 *
 * Why the probe is still a send, given the rest of this module reads: on
 * UDP 3800 listening silently instead does not work, and that is measured
 * rather than suspected. Probes are always visible on the segment, but **the reply is
 * unicast back to the requester** at both layer 2 and layer 3 — OBSERVED, in
 * a packet capture of the exchange — so a switch forwards it to no other
 * port and a silent listener sees NovaLCT scanning and never sees what
 * answered. Passive discovery cannot produce an inventory at all.
 *
 * The wait would also be unbounded: a listener sat for thirty minutes on a
 * live-show segment with an MX40 on it and heard zero probes, because VMP
 * discovers on user action rather than on a timer (OBSERVED for VMP;
 * NovaLCT's own cadence is still UNKNOWN). Passive discovery is not a thing
 * crewbox can promise, so it doesn't.
 *
 * One more thing the capture settled, which shapes what goes on the wire
 * below: the device answered the subnet broadcast and a unicast probe within
 * 12 ms each and **ignored the multicast one**, with the capture confirming
 * that packet left the host correctly. Multicast is an extra here, never the
 * path relied on.
 *
 * What this probe is, precisely: a broadcast UDP read with no addressed
 * target, no register address and no write bit. It cannot change controller
 * state. That reasoning is REASONED rather than OBSERVED — nobody has run it
 * against hardware — which is exactly why it is behind two confirmations and
 * never on a timer. See docs/VIDEO_MONITORING.md.
 */

/** The probe. Eight ASCII bytes, and the whole packet. */
export const PROBE = Buffer.from('rqProMI:', 'ascii')

/** What a controller's answer starts with. */
export const REPLY_PREFIX = Buffer.from('rpProMI:', 'ascii')

/** NovaStar's discovery multicast group, alongside the subnet broadcast. */
export const DISCOVERY_GROUP = '224.224.125.119'

/**
 * How long replies are collected after the probe goes out.
 *
 * A little over the MX30's 3.0 s announcement interval, so the window always
 * holds one: at exactly 3 s an announcement landing just outside it was a
 * coin toss.
 */
export const LISTEN_MS = 3_500

/**
 * Where an MX30's announcements arrive. The first of the four ports it sends
 * to, and the one novasun's receive-only listener uses (OBSERVED).
 */
export const ANNOUNCE_PORT = 54622

/** A scan that finds more than this is looking at something that isn't a wall. */
export const MAX_FOUND = 64

export interface DiscoveredProcessor {
  /** The device's identity. The reply's source address, and nothing else. */
  host: string
  /**
   * Whatever followed `rpProMI:`, when it was printable text.
   *
   * Deliberately not parsed into model or name. An earlier note in novasun
   * claimed the reply "appears to carry model and name information"; that was
   * an inference from a published client discarding the bytes, and it was
   * withdrawn. A real reply has since been captured and it does not rescue
   * the guess: 16 bytes, the `rpProMI:` prefix and an 8-byte ASCII tail —
   * `App,0161` on a NovaPro UHD Jr, stable across a power cycle — carrying
   * **no model ID and no device name** (OBSERVED). What `App` and `0161` mean
   * is UNKNOWN, and whether the tail is fixed-width on other models is too.
   *
   * So this stays an unlabelled string: identity comes from the HTTP API or
   * SNMP, and a wrong label on a screen is worse than a blank.
   */
  payload?: string
}

/**
 * An MX30's announcement, or null for anything else on the port.
 *
 * 96 bytes of JSON, byte-identical every time:
 * `{"data":[{"apiPort":"8001","mac":"…","authType":0,"workMode":0,"https":"9001"}]}`
 * (OBSERVED). No model, name or state — it shows that the controller is
 * there, not what it is or whether the wall behind it is connected; it went
 * on arriving with every output line unplugged. So only the API port is
 * kept, for the row; identity comes from `/api/v1/device/hw` once somebody
 * chooses to watch it.
 */
export function parseAnnouncement(buf: Buffer): { apiPort: string } | null {
  if (buf.length > 1024) return null
  try {
    const parsed = JSON.parse(buf.toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const data = (parsed as { data?: unknown }).data
    const first: unknown = Array.isArray(data) ? data[0] : undefined
    if (typeof first !== 'object' || first === null) return null
    const port = (first as { apiPort?: unknown }).apiPort
    const mac = (first as { mac?: unknown }).mac
    if (typeof port !== 'string' || !/^\d{1,5}$/.test(port)) return null
    if (typeof mac !== 'string') return null
    return { apiPort: port }
  } catch {
    return null
  }
}

export interface ScanResult {
  found: DiscoveredProcessor[]
  /** Exactly what went on the wire, for somebody who has to justify it. */
  sent: string[]
  /** Anything that stopped the scan doing what it meant to. */
  errors: string[]
}

export interface ScanIo {
  createSocket: (options: dgram.SocketOptions) => dgram.Socket
  /** Injectable so tests never sleep. */
  wait: (ms: number) => Promise<void>
  interfaces: typeof networkInterfaces
}

export const realScanIo: ScanIo = {
  createSocket: (options) => dgram.createSocket(options),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  interfaces: networkInterfaces,
}

/**
 * The broadcast address of the subnet `ip` sits on.
 *
 * Preferred over 255.255.255.255: a limited broadcast goes out of every
 * interface the routing table fancies, which on a box that also holds the
 * crew Wi-Fi means probing a network nobody asked about. A directed
 * broadcast reaches exactly the segment the admin pointed at.
 */
export function subnetBroadcast(ip: string, netmask: string): string | null {
  if (!isIpv4(ip) || !isIpv4(netmask)) return null
  const a = ip.split('.').map(Number)
  const m = netmask.split('.').map(Number)
  return a.map((octet, i) => (octet & m[i]) | (~m[i] & 0xff)).join('.')
}

/**
 * Is this the broadcast address of a subnet the box is actually on?
 *
 * The one class `isUnicastIpv4` cannot recognise, because it is not in the
 * address — `10.0.30.255` is a host on a /16 and everybody on a /24, and
 * only the netmask says which. A UDP datagram to it reaches every device on
 * that segment, which is the same beacon the multicast check exists to stop.
 *
 * Only this box's own subnets are checked, which is all that can be: an
 * address on a network the box is not on cannot be reached anyway, and
 * guessing its mask would refuse legitimate hosts.
 */
export function isOwnBroadcast(host: string, interfaces: ScanIo['interfaces']): boolean {
  for (const addresses of Object.values(interfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4') continue
      if (subnetBroadcast(address.address, address.netmask) === host) return true
    }
  }
  return false
}

/** The netmask an interface IP the box actually holds is configured with. */
function netmaskFor(ip: string, io: ScanIo): string | null {
  for (const addresses of Object.values(io.interfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && address.address === ip) return address.netmask
    }
  }
  return null
}

/** The broadcast address for an interface IP the box actually holds. */
export function broadcastFor(ip: string, io: ScanIo): string | null {
  const mask = netmaskFor(ip, io)
  return mask ? subnetBroadcast(ip, mask) : null
}

/**
 * Is `host` on the same subnet as the adapter the scan was pointed at?
 *
 * The socket has to bind the wildcard to hear broadcast and multicast at
 * all (see `scan`), which means it can also hear whatever arrives on the
 * crew adapter. Nothing should be listed as a video processor because it
 * answered on a network nobody pointed this at.
 */
export function onSameSubnet(host: string, interfaceIp: string, io: ScanIo): boolean {
  const mask = netmaskFor(interfaceIp, io)
  if (!mask) return false
  return subnetBroadcast(host, mask) === subnetBroadcast(interfaceIp, mask)
}

/**
 * Send one probe and collect what answers.
 *
 * One socket, created here and closed in `finally`, so nothing is held open
 * on a video network between scans. Never throws: a scan that cannot open a
 * socket is a result with an error in it, not a crash on the box.
 */
export async function scan(interfaceIp: string, io: ScanIo): Promise<ScanResult> {
  const found = new Map<string, DiscoveredProcessor>()
  const sent: string[] = []
  const errors: string[] = []

  const broadcast = interfaceIp ? broadcastFor(interfaceIp, io) : null
  if (interfaceIp && !broadcast) {
    errors.push(`${interfaceIp} is not an address this box holds`)
    return { found: [], sent, errors }
  }

  // Ears first, so an announcement that lands while the probe goes out is
  // heard. Receive-only: nothing is ever sent from this socket.
  const announcements = io.createSocket({ type: 'udp4', reuseAddr: true })
  try {
    await new Promise<void>((resolve, reject) => {
      announcements.once('error', reject)
      announcements.bind(ANNOUNCE_PORT, () => resolve())
    })
    announcements.on('message', (buf, rinfo) => {
      if (found.size >= MAX_FOUND || found.has(rinfo.address)) return
      if (interfaceIp && !onSameSubnet(rinfo.address, interfaceIp, io)) return
      const heard = parseAnnouncement(buf)
      if (!heard) return
      found.set(rinfo.address, {
        host: rinfo.address,
        payload: `announced itself (API port ${heard.apiPort})`,
      })
    })
  } catch (err) {
    // Not fatal: the probe half still works. Most likely something else on
    // the box already holds the port.
    errors.push(`could not listen for announcements on ${ANNOUNCE_PORT}: ${String(err)}`)
  }

  const socket = io.createSocket({ type: 'udp4', reuseAddr: true })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      // The wildcard, not the adapter's own address.
      //
      // A socket bound to a unicast address does not receive datagrams sent
      // to the subnet's broadcast address or to a multicast group — which
      // is every reply this scan is waiting for. It bound the adapter to
      // keep the probe off other networks; that is what
      // `setMulticastInterface` and a *directed* broadcast do, and they do
      // it without deafening the socket. What arrives is filtered by
      // address below instead, so binding wide costs nothing.
      socket.bind(DISCOVERY_PORT, () => resolve())
    })

    socket.on('message', (buf, rinfo) => {
      if (found.size >= MAX_FOUND) return
      // Only the network this scan was pointed at. The socket can hear every
      // adapter now, and a device answering on the crew LAN is not a video
      // processor this box was asked about.
      if (interfaceIp && !onSameSubnet(rinfo.address, interfaceIp, io)) return
      if (!buf.subarray(0, REPLY_PREFIX.length).equals(REPLY_PREFIX)) return
      // A probe reply outranks an announcement from the same address: it is
      // the more specific answer, and replacing keeps one row per host.
      const tail = buf.subarray(REPLY_PREFIX.length)
      const text = tail
        .toString('utf8')
        .replace(/[^\x20-\x7e]+/g, ' ')
        .trim()
      found.set(rinfo.address, {
        host: rinfo.address,
        ...(text.length > 0 ? { payload: text.slice(0, 64) } : {}),
      })
    })

    socket.setBroadcast(true)
    if (interfaceIp) {
      // Egress for the multicast probe, in place of the bind that used to
      // do this job badly. Broadcast needs no steering: it goes to the
      // segment's own address, not 255.255.255.255.
      try {
        socket.setMulticastInterface(interfaceIp)
      } catch (err) {
        errors.push(`could not send multicast from ${interfaceIp}: ${String(err)}`)
      }
      // ...and membership, or a reply sent to the group is never delivered
      // however it was addressed. The group was probed and never joined.
      try {
        socket.addMembership(DISCOVERY_GROUP, interfaceIp)
      } catch {
        // Not fatal: the broadcast half of the scan still works, and a
        // processor that only answers to the group is rare enough that
        // failing the whole scan over it would be worse.
      }
    }
    const targets = [broadcast, DISCOVERY_GROUP].filter((t): t is string => Boolean(t))
    for (const target of targets) {
      await new Promise<void>((resolve) => {
        socket.send(PROBE, DISCOVERY_PORT, target, (err) => {
          if (err) errors.push(`could not reach ${target}: ${err.message}`)
          else sent.push(`8 bytes "rqProMI:" to ${target}:${DISCOVERY_PORT} (UDP)`)
          resolve()
        })
      })
    }

    await io.wait(LISTEN_MS)
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'scan failed')
  } finally {
    for (const s of [socket, announcements]) {
      try {
        s.close()
      } catch {
        // Never bound, or already closed. Either way there is nothing to close.
      }
    }
  }

  return { found: [...found.values()], sent, errors }
}
