import dgram from 'node:dgram'
import { parseArtNet } from './artnet.ts'
import { DISCOVERY_UNIVERSE, parseSacn, parseSacnDiscovery, parseSacnSync } from './sacn.ts'
import { DmxState } from './state.ts'

/**
 * The only part of crewbox that touches a lighting network.
 *
 * It opens two UDP sockets and reads them. It does not, and structurally
 * cannot, write to either — see `receiveOnly` below. A festival lighting
 * network carries the show, and every crew phone on the box inherits whatever
 * the box is capable of, so "read-only" is worth more as a property of the
 * code than as a promise in a document.
 */

export const ARTNET_PORT = 6454
export const SACN_PORT = 5568

/**
 * How many multicast groups one socket may join.
 *
 * Linux allows 20 by default (`net.ipv4.igmp_max_memberships`) and fails the
 * rest, so the limit is enforced here with an error someone can act on rather
 * than discovered as a universe that mysteriously never arrives. 16 leaves
 * headroom under the smallest limit worth worrying about.
 */
export const MAX_SACN_UNIVERSES = 16

export type DmxMode = 'off' | 'artnet' | 'sacn' | 'both'

export interface DmxListenerOptions {
  mode: DmxMode
  /** Interface to join multicast groups on. Not a bind address — see below. */
  interfaceIp?: string
  /** sACN universes to join. Ignored for Art-Net, which is broadcast. */
  universes: number[]
  /** Plot universe that Art-Net universe 0 maps to. */
  artnetBase: number
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
  /** Injectable for tests; defaults to the real thing. */
  createSocket?: (options: dgram.SocketOptions) => dgram.Socket
  /** How long between attempts at a group that would not join. Tests set it. */
  joinRetryMs?: number
}

export interface DmxListenerStatus {
  mode: DmxMode
  artnet: { listening: boolean; error: string | null }
  sacn: {
    listening: boolean
    error: string | null
    joined: number[]
    /** Universes whose group could not be joined, with why. */
    failed: Array<{ universe: number; reason: string; retrying: boolean }>
    /** Whether universe 64214 was joined, so sources can advertise to us. */
    discovery: boolean
  }
  interfaceIp: string | null
  /** Packets accepted since start, across both protocols. */
  packets: number
  /** Packets that arrived on the port and were not ours. */
  ignored: number
}

/** The multicast group an sACN universe lives on. */
export const sacnGroup = (universe: number): string =>
  `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`

/** Thrown if anything ever tries to transmit from one of these sockets. */
export class DmxTransmitAttempt extends Error {
  constructor() {
    super('crewbox never transmits on a lighting network')
    this.name = 'DmxTransmitAttempt'
  }
}

/**
 * Take away a socket's ability to send, before it is used for anything.
 *
 * Not a convention and not a review rule: after this the method is gone, so a
 * future change that tries to answer an ArtPoll or "just send one discovery
 * packet" fails loudly in development instead of quietly putting traffic on a
 * show network. The test suite asserts it throws.
 *
 * Exported because the media-network watchers (server/src/netwatch) make the
 * same promise on the same grounds, and one implementation keeps it one
 * promise.
 */
export function receiveOnly(socket: dgram.Socket): dgram.Socket {
  const refuse = () => {
    throw new DmxTransmitAttempt()
  }
  socket.send = refuse as unknown as dgram.Socket['send']
  return socket
}

export class DmxListener {
  readonly state: DmxState
  private readonly options: DmxListenerOptions
  private readonly create: (options: dgram.SocketOptions) => dgram.Socket
  private artnetSocket: dgram.Socket | null = null
  private sacnSocket: dgram.Socket | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private status: DmxListenerStatus
  /**
   * Groups still to be joined, and when the next attempt is due.
   *
   * A membership is not a one-shot: `IP_ADD_MEMBERSHIP` fails with `ENODEV`
   * or `EADDRNOTAVAIL` while the interface is still coming up, and a box
   * powered on with the rest of the rack routinely wins that race against
   * the switch. It used to fail once at bind and stay failed for the run —
   * the universe silently never arrived, and the only fix was a restart
   * somebody had to think of.
   */
  private pendingJoins = new Set<number>()
  private discoveryPending = false
  private nextJoinAttempt = 0

  constructor(options: DmxListenerOptions) {
    this.options = options
    this.create = options.createSocket ?? ((o) => dgram.createSocket(o))
    this.state = new DmxState({ artnetBase: options.artnetBase })
    this.status = {
      mode: options.mode,
      artnet: { listening: false, error: null },
      sacn: { listening: false, error: null, joined: [], failed: [], discovery: false },
      interfaceIp: options.interfaceIp ?? null,
      packets: 0,
      ignored: 0,
    }
  }

  /** Never throws: a lighting network that won't open is a status, not a crash. */
  start(): void {
    if (this.options.mode === 'off') return
    if (this.options.mode !== 'sacn') this.startArtNet()
    if (this.options.mode !== 'artnet') this.startSacn()
    // Sources are only "gone" when they stop arriving, which nothing tells us.
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      this.state.sweep(now)
      this.retryJoins(now)
    }, 1000)
    this.sweepTimer.unref()
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    for (const socket of [this.artnetSocket, this.sacnSocket]) {
      try {
        socket?.close()
      } catch {
        // Already closed, or never bound. Either way there is nothing to do.
      }
    }
    this.artnetSocket = null
    this.sacnSocket = null
    this.pendingJoins.clear()
    this.discoveryPending = false
    this.nextJoinAttempt = 0
    this.status.artnet.listening = false
    this.status.sacn.listening = false
    this.status.sacn.discovery = false
    this.state.clear()
  }

  snapshot(): DmxListenerStatus {
    return {
      ...this.status,
      artnet: { ...this.status.artnet },
      sacn: { ...this.status.sacn, joined: [...this.status.sacn.joined] },
    }
  }

  private startArtNet(): void {
    const socket = receiveOnly(this.create({ type: 'udp4', reuseAddr: true }))
    this.artnetSocket = socket
    socket.on('error', (err) => {
      this.status.artnet.error = err.message
      this.status.artnet.listening = false
      this.options.log?.warn(`Art-Net listener: ${err.message}`)
    })
    socket.on('message', (buf, rinfo) => {
      const packet = parseArtNet(buf, rinfo.address)
      if (!packet) {
        this.status.ignored++
        return
      }
      this.status.packets++
      if (packet.kind === 'pollReply') {
        this.state.noteNode(packet.reply, Date.now())
        return
      }
      if (packet.kind === 'sync') {
        // Every node on the network is now buffering ArtDmx, so the levels
        // being read are queued rather than on stage until the next one.
        this.state.noteArtSync(Date.now())
        return
      }
      this.state.apply(packet.frame, Date.now())
    })
    // Art-Net is broadcast, so there is nothing to join — just the port.
    socket.bind(ARTNET_PORT, () => {
      this.status.artnet.listening = true
      this.options.log?.info(`Art-Net: listening on ${ARTNET_PORT}`)
    })
  }

  private startSacn(): void {
    const socket = receiveOnly(this.create({ type: 'udp4', reuseAddr: true }))
    this.sacnSocket = socket
    socket.on('error', (err) => {
      this.status.sacn.error = err.message
      this.status.sacn.listening = false
      this.options.log?.warn(`sACN listener: ${err.message}`)
    })
    socket.on('message', (buf) => {
      const frame = parseSacn(buf)
      if (frame) {
        this.status.packets++
        this.state.apply(frame, Date.now())
        return
      }
      // Data and synchronization packets differ from the root vector onwards,
      // so `parseSacn` has already bailed at octet 18 by the time we get here
      // and this second pass costs a header check, not a second parse.
      const sync = parseSacnSync(buf)
      if (sync) {
        this.status.packets++
        this.state.noteSacnSync(sync.syncAddress, Date.now())
        return
      }
      const discovery = parseSacnDiscovery(buf)
      if (discovery) {
        this.status.packets++
        this.state.noteDiscovery(discovery, Date.now())
        return
      }
      this.status.ignored++
    })

    // Bind 0.0.0.0, never a specific unicast address: on Linux, binding to an
    // interface's own IP stops multicast arriving at all. The interface is
    // chosen per group below instead.
    socket.bind(SACN_PORT, () => {
      this.status.sacn.listening = true

      // Universe discovery first, and unconditionally. E1.31 §12 says it
      // exists precisely so a monitoring system does not have to join every
      // group to find out what is being transmitted — which is this box's
      // whole problem — so it earns its one membership before any universe
      // somebody guessed at. 16 universes plus this is 17, still inside the
      // 20 the kernel allows.
      //
      // Kept out of `joined`, which means "universes you asked to watch": it
      // is not one of those, and counting it there would report 17 to
      // somebody who listed 16.
      // Not fatal if it fails: everything else still works, there is just no
      // "here is what the desks are sending" to show, and the admin panel
      // says so where it would have shown it. Worth retrying all the same.
      this.status.sacn.discovery = this.join(socket, DISCOVERY_UNIVERSE)
      this.discoveryPending = !this.status.sacn.discovery

      const wanted = this.options.universes.slice(0, MAX_SACN_UNIVERSES)
      const dropped = this.options.universes.slice(MAX_SACN_UNIVERSES)
      for (const universe of wanted) this.joinUniverse(socket, universe)
      for (const universe of dropped) {
        // Ours, not the kernel's, and it will not change by waiting.
        this.status.sacn.failed.push({
          universe,
          reason: `over the ${MAX_SACN_UNIVERSES} limit`,
          retrying: false,
        })
      }
      this.state.watchSyncUniverses(this.status.sacn.joined)
      this.options.log?.info(
        `sACN: listening on ${SACN_PORT}, joined ${this.status.sacn.joined.length}` +
          (this.options.interfaceIp ? ` via ${this.options.interfaceIp}` : '')
      )
      const stuck = this.status.sacn.failed.filter((f) => !f.retrying)
      if (stuck.length > 0) {
        this.options.log?.warn(
          `sACN: cannot join ${stuck.map((f) => f.universe).join(', ')} — ` +
            stuck.map((f) => f.reason).join(', ')
        )
      }
      if (this.pendingJoins.size > 0 || this.discoveryPending) {
        this.options.log?.warn(
          `sACN: could not join ${[...this.pendingJoins].join(', ') || 'discovery'} yet — ` +
            'retrying, the interface may still be coming up'
        )
      }
    })
  }

  /** One membership attempt. True if the group is now joined. */
  private join(socket: dgram.Socket, universe: number): boolean {
    try {
      if (this.options.interfaceIp) {
        socket.addMembership(sacnGroup(universe), this.options.interfaceIp)
      } else {
        socket.addMembership(sacnGroup(universe))
      }
      return true
    } catch (err) {
      this.lastJoinError = joinReason(err)
      return false
    }
  }

  private lastJoinError = 'failed'

  /**
   * Join one universe, or queue it for another go.
   *
   * A membership that failed because the socket is full will fail the same
   * way forever, so it is reported as settled; anything else is provisional
   * and gets retried, because the usual cause is an interface that is not up
   * yet and will be in a few seconds.
   */
  private joinUniverse(socket: dgram.Socket, universe: number): void {
    if (this.join(socket, universe)) {
      this.status.sacn.joined.push(universe)
      this.status.sacn.joined.sort((a, b) => a - b)
      this.pendingJoins.delete(universe)
      this.status.sacn.failed = this.status.sacn.failed.filter((f) => f.universe !== universe)
      return
    }
    const reason = this.lastJoinError
    const retrying = !isFull(reason)
    if (retrying) this.pendingJoins.add(universe)
    else this.pendingJoins.delete(universe)
    const existing = this.status.sacn.failed.find((f) => f.universe === universe)
    if (existing) {
      existing.reason = reason
      existing.retrying = retrying
    } else {
      this.status.sacn.failed.push({ universe, reason, retrying })
    }
  }

  /**
   * Try the groups that have not joined yet, every few seconds.
   *
   * Every few and not every one: a failing `addMembership` is a syscall, and
   * an interface that is genuinely absent for a whole show would otherwise
   * make one per universe per second for the run. Slow enough to be free,
   * fast enough that a cable plugged in during focus is watching before
   * anyone has walked back to the desk.
   */
  private retryJoins(now: number): void {
    const socket = this.sacnSocket
    if (!socket || !this.status.sacn.listening) return
    if (this.pendingJoins.size === 0 && !this.discoveryPending) return
    if (now < this.nextJoinAttempt) return
    this.nextJoinAttempt = now + (this.options.joinRetryMs ?? JOIN_RETRY_MS)

    if (this.discoveryPending && this.join(socket, DISCOVERY_UNIVERSE)) {
      this.discoveryPending = false
      this.status.sacn.discovery = true
    }
    const before = this.status.sacn.joined.length
    for (const universe of [...this.pendingJoins]) this.joinUniverse(socket, universe)
    if (this.status.sacn.joined.length === before) return
    this.state.watchSyncUniverses(this.status.sacn.joined)
    this.options.log?.info(
      `sACN: joined ${this.status.sacn.joined.length} universes` +
        (this.pendingJoins.size > 0 ? `, still trying ${[...this.pendingJoins].join(', ')}` : '')
    )
  }
}

/** Seconds, not the sweep's one second — see `retryJoins`. */
const JOIN_RETRY_MS = 10_000

/** The error code, when there is one: `ENODEV` says more than its message. */
const joinReason = (err: unknown): string =>
  err instanceof Error ? String(('code' in err && err.code) || err.message) : 'failed'

/**
 * Is this "the socket is full", the one failure waiting cannot fix?
 *
 * Linux answers `IP_ADD_MEMBERSHIP` past `net.ipv4.igmp_max_memberships`
 * with ENOBUFS, and there is nothing to retry: the 21st group will be
 * refused as surely in an hour as it was at boot.
 */
const isFull = (reason: string): boolean => reason === 'ENOBUFS' || reason === 'ENOMEM'

/** Expand "1-8,101" into universe numbers. Junk is skipped, not fatal. */
export function parseUniverseList(spec: string): number[] {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      // Bounded so a typo like 1-63999 doesn't spin building a huge list.
      for (let u = from; u <= to && u - from < 512; u++) out.add(u)
    } else if (/^\s*\d+\s*$/.test(part)) {
      out.add(Number(part.trim()))
    }
  }
  return [...out].filter((u) => u >= 1 && u <= 63999).sort((a, b) => a - b)
}
