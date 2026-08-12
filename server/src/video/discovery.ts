import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { DISCOVERY_PORT, isIpv4 } from '@crewbox/shared'

/**
 * The one scan, and only when an admin has confirmed it twice.
 *
 * NovaLCT and VMP find controllers by broadcasting eight ASCII bytes,
 * `rqProMI:`, on UDP 3800 and reading what answers. That is what this does,
 * once, on demand.
 *
 * Why it is a send at all, given the rest of this module reads: novasun looked
 * at listening silently instead, and the answer came back UNKNOWN in the half
 * that matters. Probes are always visible on the segment, but whether the
 * *replies* are broadcast or unicast back to the requester is not established
 * — and unicast is the likelier design, which would mean a silent listener
 * sees NovaLCT scanning and never sees what answered. NovaLCT's own cadence
 * may also be driven by a human clicking rather than a timer, so a passive
 * wait could last all night. Passive discovery is not a thing crewbox can
 * promise, so it doesn't.
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

/** How long replies are collected after the probe goes out. */
export const LISTEN_MS = 3_000

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
   * an inference from a published client discarding the bytes, it was never
   * observed, and it has since been withdrawn. Until somebody captures a real
   * reply this is shown as an unlabelled string or not at all — a wrong label
   * on a screen is worse than a blank.
   */
  payload?: string
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

/** The broadcast address for an interface IP the box actually holds. */
export function broadcastFor(ip: string, io: ScanIo): string | null {
  for (const addresses of Object.values(io.interfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.address !== ip) continue
      return subnetBroadcast(address.address, address.netmask)
    }
  }
  return null
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

  const socket = io.createSocket({ type: 'udp4', reuseAddr: true })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      // Bind to the probe port so replies sent back to it arrive, and to the
      // chosen interface so nothing leaves on the crew network by accident.
      socket.bind(DISCOVERY_PORT, interfaceIp || undefined, () => resolve())
    })

    socket.on('message', (buf, rinfo) => {
      if (found.size >= MAX_FOUND) return
      if (!buf.subarray(0, REPLY_PREFIX.length).equals(REPLY_PREFIX)) return
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
    try {
      socket.close()
    } catch {
      // Never bound, or already closed. Either way there is nothing to close.
    }
  }

  return { found: [...found.values()], sent, errors }
}
