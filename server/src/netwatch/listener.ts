import dgram from 'node:dgram'
import { receiveOnly } from '../dmx/listener.ts'
import { MDNS_GROUP, MDNS_PORT, MdnsState, parseMdns } from './mdns.ts'
import { PTP_EVENT_PORT, PTP_GENERAL_PORT, PTP_GROUP, PtpState, parsePtp } from './ptp.ts'
import { SAP_GROUP, SAP_PORT, SapState, parseSap } from './sap.ts'

/**
 * The media-network watchers: PTP clock health, the mDNS device roster
 * (Dante, NDI), and the SAP stream directory (AES67/RAVENNA).
 *
 * Everything here is overheard. All four sockets have `send` removed before
 * first use — the same structural guarantee the DMX listener makes, made by
 * the same function — so crewbox on an audio network is as silent as
 * crewbox on a lighting network. Off by default; a box never watches a
 * network it wasn't pointed at.
 *
 * Port sharing: mDNS responders (Bonjour, Avahi) and PTP daemons (Dante
 * Virtual Soundcard) bind these same ports. The sockets are opened with
 * reuseAddr, which is the standard arrangement for multicast listeners
 * sharing a port; where the OS still refuses, the failure lands in the
 * status and the panel says which watcher is dark, rather than the box
 * failing to start.
 */

export interface NetWatchOptions {
  /** Interface to join the multicast groups on — not a bind address. */
  interfaceIp?: string
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
  /** Injectable for tests; defaults to the real thing. */
  createSocket?: (options: dgram.SocketOptions) => dgram.Socket
  /**
   * Port overrides, for tests only: 319/320 are privileged on Linux and
   * 5353 is contended by every mDNS responder, so tests bind high ports.
   * What is under test is the routing and the read-only guarantee, not the
   * IANA registry.
   */
  ports?: { ptpEvent?: number; ptpGeneral?: number; mdns?: number; sap?: number }
}

export interface WatcherStatus {
  listening: boolean
  error: string | null
  packets: number
}

export interface NetWatchStatus {
  ptp: WatcherStatus
  mdns: WatcherStatus
  sap: WatcherStatus
  interfaceIp: string | null
}

export class NetWatch {
  readonly ptp = new PtpState()
  readonly mdns = new MdnsState()
  readonly sap = new SapState()
  private readonly options: NetWatchOptions
  private readonly create: (options: dgram.SocketOptions) => dgram.Socket
  private readonly sockets: dgram.Socket[] = []
  private sweepTimer: NodeJS.Timeout | null = null
  private readonly status: NetWatchStatus

  constructor(options: NetWatchOptions = {}) {
    this.options = options
    this.create = options.createSocket ?? ((o) => dgram.createSocket(o))
    this.status = {
      ptp: { listening: false, error: null, packets: 0 },
      mdns: { listening: false, error: null, packets: 0 },
      sap: { listening: false, error: null, packets: 0 },
      interfaceIp: options.interfaceIp ?? null,
    }
  }

  /** Never throws — a watcher that can't open is a status line, not a crash. */
  start(): void {
    // PTP splits event and general messages across two ports; both matter
    // (Announce carries the grandmaster, Sync carries the beat) and both
    // land in the one PtpState.
    const ports = this.options.ports ?? {}
    const handlePtp = (buf: Buffer): boolean => {
      const message = parsePtp(buf)
      if (!message) return false
      this.ptp.apply(message, Date.now())
      return true
    }
    this.open(ports.ptpEvent ?? PTP_EVENT_PORT, PTP_GROUP, this.status.ptp, handlePtp)
    this.open(ports.ptpGeneral ?? PTP_GENERAL_PORT, PTP_GROUP, this.status.ptp, handlePtp)
    this.open(ports.mdns ?? MDNS_PORT, MDNS_GROUP, this.status.mdns, (buf) => {
      const records = parseMdns(buf)
      if (records.length === 0) return false
      this.mdns.applyPacket(records, Date.now())
      return true
    })
    this.open(ports.sap ?? SAP_PORT, SAP_GROUP, this.status.sap, (buf) => {
      const message = parseSap(buf)
      if (!message) return false
      this.sap.apply(message, Date.now())
      return true
    })

    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      this.ptp.sweep(now)
      this.sap.sweep(now)
    }, 1000)
    this.sweepTimer.unref()
  }

  private open(
    port: number,
    group: string,
    status: WatcherStatus,
    handle: (buf: Buffer) => boolean
  ): void {
    const socket = receiveOnly(this.create({ type: 'udp4', reuseAddr: true }))
    this.sockets.push(socket)
    socket.on('error', (err) => {
      status.error = err.message
      status.listening = false
      this.options.log?.warn(`netwatch :${port}: ${err.message}`)
    })
    socket.on('message', (buf) => {
      if (handle(buf)) status.packets++
    })
    // Bind 0.0.0.0, never a unicast address — binding to an interface's own
    // IP stops multicast arriving on Linux. The interface is chosen at join.
    socket.bind(port, () => {
      try {
        if (this.options.interfaceIp) {
          socket.addMembership(group, this.options.interfaceIp)
        } else {
          socket.addMembership(group)
        }
        status.listening = true
        this.options.log?.info(`netwatch: listening on ${group}:${port}`)
      } catch (err) {
        status.error = err instanceof Error ? err.message : String(err)
        this.options.log?.warn(`netwatch: could not join ${group}: ${status.error}`)
      }
    })
  }

  snapshot(): NetWatchStatus {
    return {
      ptp: { ...this.status.ptp },
      mdns: { ...this.status.mdns },
      sap: { ...this.status.sap },
      interfaceIp: this.status.interfaceIp,
    }
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    for (const socket of this.sockets) {
      try {
        socket.close()
      } catch {
        // Already closed, or never bound — nothing to do either way.
      }
    }
    this.sockets.length = 0
    this.status.ptp.listening = false
    this.status.mdns.listening = false
    this.status.sap.listening = false
    this.ptp.clear()
    this.mdns.clear()
    this.sap.clear()
  }
}
