import type dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { newId } from '@crewbox/shared'
import type { Probes } from '../environment.ts'
// One implementation of "the broadcast address of the segment this adapter is
// on", shared with the video scan, which made the same promise first.
import { subnetBroadcast } from '../video/discovery.ts'
import type { MetricsStore } from './metrics.ts'
import type { MediaService } from '../netwatch/mdns.ts'
import type { St2110 } from '../st2110.ts'
import {
  findingLines,
  nodeHttpGet,
  pickRegistry,
  readFailure,
  readRegistry,
  registrySummary,
  type HttpGet,
} from './nmos.ts'

/**
 * The deep probe: the audit's one deliberate exception to "never transmit",
 * taken only when an admin pushes the button.
 *
 * Ground rules, enforced by construction:
 * - The passive listeners are never touched. Every packet here leaves from
 *   a fresh socket created inside the sweep and closed in `finally`; the
 *   replies it solicits arrive on the existing receive-only listeners,
 *   which is what keeps their guarantee intact.
 * - Each probe records `sent` — a human description of exactly what was
 *   transmitted — so the report shows venue IT precisely what the box put
 *   on their wire and they can verify it against a capture.
 * - What is deliberately absent is as designed as what is present: nothing
 *   on the PTP ports (transmitting near a clock election risks the fault
 *   the audit exists to find), no IGMP (receiving it needs a raw socket
 *   the box is not granted, and winning the querier election only to
 *   vanish would *cause* cyclic outages), no ICMP sweeps or port scans
 *   (show-network devices' watchdogs treat them as attacks; privilege is
 *   not the reason, since a connect needs none and on most systems a ping
 *   needs none either). sACN needs no probe at all — E1.31 universe
 *   discovery is already broadcast every 10 s and collected passively.
 *
 * The Art-Net probe is one ArtPoll — the discovery packet every console on
 * the network already broadcasts every ~3 seconds; one more per manual
 * admin push is strictly less than ambient traffic. It is skipped unless a
 * lighting interface is explicitly configured, so it can never leave on the
 * crew LAN by accident. The mDNS probe is the one-shot multicast query
 * (RFC 6762 §5.1) every phone on the network performs continuously.
 *
 * The NMOS probe reads the registry ST 2110 kit registers with (IS-04),
 * over HTTP, and each sender's SDP file from its device: what any NMOS
 * controller on that network does all day. It goes only to a registry
 * named in Box settings or one that announced itself, and leaves from the
 * media network's adapter when one is set. Its `sent` line counts the
 * requests and the devices they went to.
 */

export const ARTNET_PORT = 6454
export const MDNS_PORT = 5353
export const MDNS_GROUP = '224.0.0.251'

/** How long solicited replies are given to land on the passive listeners. */
export const REPLY_WAIT_MS = 5_000

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "10.20.0.5:8080" from a URL, or the text itself when it is not one. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export type ProbeState = 'ok' | 'info' | 'limited' | 'off' | 'skipped'

export interface ProbeResult {
  id: 'crew-uplink' | 'crew-dns' | 'artnet-inventory' | 'mdns-roster' | 'nmos-registry'
  network: 'crew' | 'lighting' | 'media'
  state: ProbeState
  /** Exactly what was transmitted, in words venue IT can verify. */
  sent: string
  detail: string
  fix?: string
  /** What the probe found, one line each, when there is a list: the NMOS findings. */
  items?: string[]
}

export interface ProbeRun {
  id: string
  startedAt: number
  finishedAt: number | null
  by: string
  probes: ProbeResult[]
}

export interface AuditProbeIo {
  createSocket: (options: dgram.SocketOptions) => dgram.Socket
  env: Probes
  now: () => number
  /** Injectable so tests never sleep. */
  wait: (ms: number) => Promise<void>
  /** The box's adapters, for working out where a broadcast should go. */
  interfaces?: typeof networkInterfaces
  /** HTTP GET, for the NMOS registry; Node's own client when omitted. */
  httpGet?: HttpGet
}

export interface ProberDeps {
  /** Lighting-network interface IP; '' skips the Art-Net probe entirely. */
  dmxIface: () => string
  /** Media-watch interface IP for the mDNS query ('' = OS default). */
  watchIface: () => string
  /** Art-Net node count, before/after — the passive listener's inventory. */
  nodeCount?: () => number
  /** mDNS roster size, before/after. */
  mdnsCount?: () => number
  /** The certificate's hostname, for the venue-DNS check. */
  certHostname: () => string | undefined
  /** Whether the media watchers are running (mDNS replies need a listener). */
  watching: () => boolean
  /** The mDNS roster, where registries that announced themselves are found. */
  mdnsRoster?: () => MediaService[]
  /** The NMOS registry Box settings names, or '' to use one that announced itself. */
  nmosRegistry?: () => string
  /** The ST 2110 checks, or null when they did not load. */
  checks?: () => Pick<St2110, 'checkRegistry'> | null
  /**
   * Whether this box may go off-site at all. CREWBOX_UPDATE_CHECK=0 says it
   * may not, and the uplink probe then sends nothing. Omitted, it may.
   */
  outbound?: () => boolean
}

/**
 * One ArtPoll, byte for byte (Art-Net 4, OpPoll):
 * "Art-Net\0" + opcode 0x2000 little-endian + ProtVer 14 + TalkToMe 0
 * (no diagnostics requested, no continuous replies) + Priority 0.
 */
export function buildArtPoll(): Buffer {
  const packet = Buffer.alloc(14)
  packet.write('Art-Net\0', 0, 'latin1')
  packet.writeUInt16LE(0x2000, 8) // OpPoll
  packet.writeUInt8(0, 10) // ProtVer hi
  packet.writeUInt8(14, 11) // ProtVer lo
  packet.writeUInt8(0, 12) // TalkToMe: unicast replies only when polled
  packet.writeUInt8(0, 13) // DiagPriority: none requested
  return packet
}

/** Encode one DNS name as length-prefixed labels. */
function dnsName(name: string): Buffer {
  const parts = name.split('.')
  const bytes: number[] = []
  for (const part of parts) {
    bytes.push(part.length)
    for (const ch of part) bytes.push(ch.charCodeAt(0))
  }
  bytes.push(0)
  return Buffer.from(bytes)
}

/**
 * One one-shot mDNS query (RFC 6762 §5.1): header with QDCOUNT 3, then PTR
 * questions for the Dante, NDI and NMOS Query API service types. QM
 * (multicast response) so the answers are heard by the passive listener —
 * and by every other device on the network, exactly like any phone's
 * discovery.
 */
export function buildMdnsQuery(): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0) // ID 0 (mDNS)
  header.writeUInt16BE(0, 2) // flags: standard query
  header.writeUInt16BE(3, 4) // QDCOUNT
  const question = (name: string): Buffer => {
    const q = Buffer.alloc(4)
    q.writeUInt16BE(12, 0) // QTYPE PTR
    q.writeUInt16BE(1, 2) // QCLASS IN, QU bit clear → multicast response
    return Buffer.concat([dnsName(name), q])
  }
  return Buffer.concat([
    header,
    question('_netaudio-arc._udp.local'),
    question('_ndi._tcp.local'),
    question('_nmos-query._tcp.local'),
  ])
}

/** Send one datagram from a throwaway socket, always closed. */
function sendOnce(
  io: AuditProbeIo,
  packet: Buffer,
  address: string,
  port: number,
  configure?: (socket: dgram.Socket) => void,
  /** Local address to leave from. The only thing that steers a broadcast. */
  bindAddress?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = io.createSocket({ type: 'udp4', reuseAddr: true })
    const done = (err?: Error) => {
      try {
        socket.close()
      } catch {
        // already closed
      }
      if (err) reject(err)
      else resolve()
    }
    socket.on('error', (err) => done(err))
    const bound = () => {
      try {
        configure?.(socket)
        socket.send(packet, port, address, (err) => done(err ?? undefined))
      } catch (err) {
        done(err as Error)
      }
    }
    if (bindAddress) socket.bind(0, bindAddress, bound)
    else socket.bind(bound)
  })
}

/**
 * Where an ArtPoll from this adapter should go, and out of which address.
 *
 * `setMulticastInterface` was doing this job, and could not: it steers
 * multicast, and 255.255.255.255 is not multicast. A limited broadcast
 * leaves by whichever adapter the routing table fancies — on a box that also
 * holds the crew Wi-Fi, that is the crew Wi-Fi. So the probe promised venue
 * IT "from the lighting adapter" while putting a discovery packet on the
 * network full of phones.
 *
 * Two things fix it, and both are needed. Binding the socket to the lighting
 * address makes the datagram leave through that adapter. Addressing the
 * segment's own broadcast rather than 255.255.255.255 means that even if a
 * route did something surprising, the packet is for one named subnet and no
 * other. If the adapter is not on this box, there is nothing to be careful
 * with and the probe says so instead of guessing.
 */
export function artPollTarget(
  iface: string,
  interfaces: typeof networkInterfaces
): { address: string; from: string } | null {
  for (const addresses of Object.values(interfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.address !== iface) continue
      const broadcast = subnetBroadcast(address.address, address.netmask)
      if (broadcast) return { address: broadcast, from: iface }
    }
  }
  return null
}

export class Prober {
  private current: ProbeRun | null = null

  constructor(
    private readonly io: AuditProbeIo,
    private readonly deps: ProberDeps,
    private readonly metrics?: MetricsStore
  ) {}

  get running(): boolean {
    return this.current !== null
  }

  latest(): ProbeRun | null {
    if (this.current) return this.current
    const stored = this.metrics?.latestProbeRun()
    if (!stored) return null
    const report = stored.report as { probes?: ProbeResult[] } | null
    return {
      id: stored.id,
      startedAt: stored.startedAt,
      finishedAt: stored.finishedAt,
      by: stored.by,
      probes: Array.isArray(report?.probes) ? report.probes : [],
    }
  }

  /** Run the sweep. Throws 'busy' if one is already running. */
  async run(by: string): Promise<ProbeRun> {
    if (this.current) throw new Error('busy')
    const run: ProbeRun = {
      id: newId(),
      startedAt: this.io.now(),
      finishedAt: null,
      by,
      probes: [],
    }
    this.current = run
    // Written unfinished first, so a crash mid-sweep is visible afterwards.
    this.persist(run)
    try {
      run.probes.push(await this.probeUplink())
      run.probes.push(await this.probeDns())
      run.probes.push(await this.probeArtnet())
      run.probes.push(await this.probeMdns())
      // After the mDNS query, whose answers name the registry.
      run.probes.push(await this.probeNmos())
    } finally {
      run.finishedAt = this.io.now()
      this.persist(run)
      this.current = null
    }
    return run
  }

  private persist(run: ProbeRun): void {
    this.metrics?.saveProbeRun({
      id: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      by: run.by,
      report: { probes: run.probes },
    })
  }

  // -- the probes -------------------------------------------------------------

  private async probeUplink(): Promise<ProbeResult> {
    // The switch the startup check already honours (environment.ts). The
    // probe ignored it and connected to Cloudflare and Google on a box whose
    // operator had asked for no outbound connections at all, and pressing a
    // button labelled for the show's networks is not asking for one.
    if (this.deps.outbound?.() === false) {
      return {
        id: 'crew-uplink',
        network: 'crew',
        state: 'skipped',
        sent: 'nothing',
        detail: 'Not checked — this box is configured to make no outbound connections.',
        fix: 'Nothing here needs it. Turn on Box settings → Use the internet if you want the box to look.',
      }
    }
    const sent =
      'TCP connections to 1.1.1.1:443 and 8.8.8.8:443, and one HTTP request to gstatic generate_204'
    try {
      const reachable =
        (await this.io.env.tcpReachable('1.1.1.1', 443, 2000)) ||
        (await this.io.env.tcpReachable('8.8.8.8', 443, 2000))
      if (!reachable) {
        return {
          id: 'crew-uplink',
          network: 'crew',
          state: 'info',
          sent,
          detail: 'No internet uplink. Normal for a show LAN — nothing on site depends on it.',
        }
      }
      const open = await this.io.env.noContentOk(3000)
      if (!open) {
        return {
          id: 'crew-uplink',
          network: 'crew',
          state: 'limited',
          sent,
          detail: 'Internet reachable but a captive portal is intercepting requests.',
          fix: 'Open any http:// page once and accept the venue portal, or ask for a bypassed VLAN.',
        }
      }
      return {
        id: 'crew-uplink',
        network: 'crew',
        state: 'ok',
        sent,
        detail: 'Internet uplink working, no portal in the way.',
      }
    } catch (err) {
      return {
        id: 'crew-uplink',
        network: 'crew',
        state: 'info',
        sent,
        detail: `Uplink probe failed: ${String(err)}`,
      }
    }
  }

  private async probeDns(): Promise<ProbeResult> {
    const hostname = this.deps.certHostname()
    if (!hostname) {
      return {
        id: 'crew-dns',
        network: 'crew',
        state: 'skipped',
        sent: 'nothing',
        detail: 'No certificate hostname to check — the box serves plain HTTP.',
      }
    }
    const sent = `one DNS A query for ${hostname} via the system resolver`
    try {
      const addresses = await this.io.env.resolve4(hostname, 2500)
      const local = this.io.env.localAddresses()
      const hits = addresses.filter((a) => local.includes(a))
      if (hits.length > 0) {
        return {
          id: 'crew-dns',
          network: 'crew',
          state: 'ok',
          sent,
          detail: `${hostname} resolves to this box (${hits[0]}).`,
        }
      }
      return {
        id: 'crew-dns',
        network: 'crew',
        state: 'limited',
        sent,
        detail:
          addresses.length > 0
            ? `${hostname} resolves to ${addresses[0]}, which is not this box.`
            : `${hostname} does not resolve on this network.`,
        fix: 'Point the venue DNS override at this box — Admin → This network has the config file.',
      }
    } catch (err) {
      return {
        id: 'crew-dns',
        network: 'crew',
        state: 'limited',
        sent,
        detail: `DNS lookup failed: ${String(err)}`,
        fix: 'Point the venue DNS override at this box — Admin → This network has the config file.',
      }
    }
  }

  private async probeArtnet(): Promise<ProbeResult> {
    const iface = this.deps.dmxIface()
    if (!iface) {
      return {
        id: 'artnet-inventory',
        network: 'lighting',
        state: 'skipped',
        sent: 'nothing',
        detail:
          'Skipped: no lighting interface is configured, and this probe never transmits on a network it cannot name.',
        fix: 'Set the lighting adapter in Setup or the admin panel to include Art-Net discovery in the sweep.',
      }
    }
    const target = artPollTarget(iface, this.io.interfaces ?? networkInterfaces)
    if (!target) {
      return {
        id: 'artnet-inventory',
        network: 'lighting',
        state: 'skipped',
        sent: 'nothing',
        detail: `Skipped: no adapter on this box holds ${iface}, so a broadcast could only have gone out of whichever one the routing table picked — which may be the crew network.`,
        fix: 'Set the lighting adapter to an address this box actually has, and check its cable is in.',
      }
    }
    const before = this.deps.nodeCount?.() ?? 0
    const sent = `one ArtPoll broadcast (14 bytes, opcode 0x2000) to ${target.address}:${ARTNET_PORT} from ${target.from}`
    try {
      await sendOnce(
        this.io,
        buildArtPoll(),
        target.address,
        ARTNET_PORT,
        (socket) => socket.setBroadcast(true),
        // Leave from the lighting adapter, never the crew LAN.
        target.from
      )
    } catch (err) {
      return {
        id: 'artnet-inventory',
        network: 'lighting',
        state: 'limited',
        sent,
        detail: `ArtPoll could not be sent: ${String(err)}`,
      }
    }
    await this.io.wait(REPLY_WAIT_MS)
    const after = this.deps.nodeCount?.() ?? 0
    const woken = Math.max(0, after - before)
    return {
      id: 'artnet-inventory',
      network: 'lighting',
      state: 'ok',
      sent,
      detail:
        `${after} Art-Net node${after === 1 ? '' : 's'} in the inventory` +
        (woken > 0
          ? ` — ${woken} answered only when asked (silent until polled).`
          : after > 0
            ? ' — all were already announcing themselves.'
            : '. Nothing answered; if nodes exist, check the VLAN and broadcast domain.'),
    }
  }

  private async probeMdns(): Promise<ProbeResult> {
    if (!this.deps.watching()) {
      return {
        id: 'mdns-roster',
        network: 'media',
        state: 'skipped',
        sent: 'nothing',
        detail: 'Skipped: the media watchers are off, so solicited replies would go unheard.',
        fix: 'Turn on Box settings → Watch the media network and restart to include media discovery in the sweep.',
      }
    }
    const iface = this.deps.watchIface()
    const before = this.deps.mdnsCount?.() ?? 0
    const sent = `one mDNS query (PTR _netaudio-arc._udp.local + _ndi._tcp.local + _nmos-query._tcp.local) to ${MDNS_GROUP}:${MDNS_PORT}`
    try {
      await sendOnce(this.io, buildMdnsQuery(), MDNS_GROUP, MDNS_PORT, (socket) => {
        if (iface) socket.setMulticastInterface(iface)
      })
    } catch (err) {
      return {
        id: 'mdns-roster',
        network: 'media',
        state: 'limited',
        sent,
        detail: `mDNS query could not be sent: ${String(err)}`,
      }
    }
    await this.io.wait(REPLY_WAIT_MS)
    const after = this.deps.mdnsCount?.() ?? 0
    const woken = Math.max(0, after - before)
    return {
      id: 'mdns-roster',
      network: 'media',
      state: 'ok',
      sent,
      detail:
        `${after} media device${after === 1 ? '' : 's'} on the roster` +
        (woken > 0 ? ` — ${woken} surfaced only when asked.` : '.'),
    }
  }

  private async probeNmos(): Promise<ProbeResult> {
    const configured = this.deps.nmosRegistry?.() ?? ''
    const target = pickRegistry(configured, this.deps.mdnsRoster?.() ?? [])
    if (!target) {
      return this.deps.watching()
        ? {
            id: 'nmos-registry',
            network: 'media',
            state: 'info',
            sent: 'nothing',
            detail:
              'No NMOS registry answered the mDNS query, so there was none to read. Nothing to check on a rig without NMOS.',
            fix: "If the registry is found through the venue's DNS instead, name it in Box settings → NMOS registry.",
          }
        : {
            id: 'nmos-registry',
            network: 'media',
            state: 'skipped',
            sent: 'nothing',
            detail:
              'Skipped: no NMOS registry is named in Box settings, and with the media watchers off none can announce itself.',
            fix: 'Turn on Box settings → Watch the media network, or name the registry in Box settings → NMOS registry.',
          }
    }
    const checks = this.deps.checks?.() ?? null
    if (!checks) {
      return {
        id: 'nmos-registry',
        network: 'media',
        state: 'limited',
        sent: 'nothing',
        detail: `The ST 2110 checks could not load, so the registry at ${target.url} was not read.`,
        fix: 'Restart the box. The checks are part of it, so if this persists the download is damaged: download it again.',
      }
    }
    const iface = this.deps.watchIface()
    const get = this.io.httpGet ?? nodeHttpGet(iface || undefined)
    const found = target.from === 'setting' ? 'named in Box settings' : 'which announced itself'
    try {
      const read = await readRegistry(target.url, get, this.io.now)
      const { registry, manifests, hosts } = read.requests
      // Host and port, not the URL: the exported report stays free of
      // links, and "10.20.0.5:8080" is what venue IT will look for.
      const on = new URL(read.base).host
      const version = read.snapshot.api_version ?? ''
      const sent =
        `${plural(registry, 'HTTP GET request')} to the NMOS Query API on ${on}` +
        (manifests > 0
          ? `, and ${manifests} for senders' SDP files, to ${plural(hosts, 'device')}`
          : '') +
        (iface ? `, from ${iface}` : '')
      const report = checks.checkRegistry(read.snapshot)
      const errors = report.findings.filter((f) => f.severity === 'error').length
      const warnings = report.findings.filter((f) => f.severity === 'warning').length
      return {
        id: 'nmos-registry',
        network: 'media',
        state: errors > 0 ? 'limited' : 'ok',
        sent,
        detail:
          `The registry on ${on} (IS-04 ${version}, ${found}): ${registrySummary(report)} ` +
          (errors > 0
            ? `${plural(errors, 'fault')} a receiver or controller can trip on` +
              (warnings > 0 ? `, and ${plural(warnings, 'warning')}` : '') +
              ', listed below.'
            : warnings > 0
              ? `No faults; ${plural(warnings, 'warning')}, listed below.`
              : 'Nothing wrong with what is registered.') +
          (read.partial.length > 0 ? ` Not read: ${read.partial.join('; ')}.` : ''),
        ...(errors > 0
          ? {
              fix: 'Each line names the resource. Correct it at the device that registered it, or in the controller that set it up.',
            }
          : {}),
        ...(errors + warnings > 0 ? { items: findingLines(report) } : {}),
      }
    } catch (err) {
      const reason = readFailure(err)
      if (reason === null) throw err
      return {
        id: 'nmos-registry',
        network: 'media',
        state: 'limited',
        sent: `HTTP GET requests to ${hostOf(target.url)}`,
        detail: `The NMOS registry ${found} could not be read: ${reason}.`,
        fix:
          target.from === 'setting'
            ? 'Check the address in Box settings → NMOS registry, and that the registry is running and reachable from the media network adapter.'
            : 'Check the registry is running and reachable from the media network adapter.',
      }
    }
  }
}
