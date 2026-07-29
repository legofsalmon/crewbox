import dgram from 'node:dgram'
import { parseArtNet } from './artnet.ts'
import { parseSacn, parseSacnSync } from './sacn.ts'
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
}

export interface DmxListenerStatus {
  mode: DmxMode
  artnet: { listening: boolean; error: string | null }
  sacn: {
    listening: boolean
    error: string | null
    joined: number[]
    /** Universes whose group could not be joined, with why. */
    failed: Array<{ universe: number; reason: string }>
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
 */
function receiveOnly(socket: dgram.Socket): dgram.Socket {
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

  constructor(options: DmxListenerOptions) {
    this.options = options
    this.create = options.createSocket ?? ((o) => dgram.createSocket(o))
    this.state = new DmxState({ artnetBase: options.artnetBase })
    this.status = {
      mode: options.mode,
      artnet: { listening: false, error: null },
      sacn: { listening: false, error: null, joined: [], failed: [] },
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
    this.sweepTimer = setInterval(() => this.state.sweep(Date.now()), 1000)
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
    this.status.artnet.listening = false
    this.status.sacn.listening = false
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
        this.state.noteNode(packet.reply.ip, packet.reply.longName || packet.reply.shortName)
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
      this.status.ignored++
    })

    // Bind 0.0.0.0, never a specific unicast address: on Linux, binding to an
    // interface's own IP stops multicast arriving at all. The interface is
    // chosen per group below instead.
    socket.bind(SACN_PORT, () => {
      this.status.sacn.listening = true
      const wanted = this.options.universes.slice(0, MAX_SACN_UNIVERSES)
      const dropped = this.options.universes.slice(MAX_SACN_UNIVERSES)
      for (const universe of wanted) {
        try {
          if (this.options.interfaceIp) {
            socket.addMembership(sacnGroup(universe), this.options.interfaceIp)
          } else {
            socket.addMembership(sacnGroup(universe))
          }
          this.status.sacn.joined.push(universe)
        } catch (err) {
          const reason =
            err instanceof Error ? ('code' in err && err.code) || err.message : 'failed'
          this.status.sacn.failed.push({ universe, reason: String(reason) })
        }
      }
      for (const universe of dropped) {
        this.status.sacn.failed.push({ universe, reason: `over the ${MAX_SACN_UNIVERSES} limit` })
      }
      // Synchronization packets only reach their own universe's group
      // (E1.31 §6.3.3.1), so which groups were joined decides whether a
      // missing sync stream is a fault we can see or one we cannot.
      this.state.watchSyncUniverses(this.status.sacn.joined)
      this.options.log?.info(
        `sACN: listening on ${SACN_PORT}, joined ${this.status.sacn.joined.length}` +
          (this.options.interfaceIp ? ` via ${this.options.interfaceIp}` : '')
      )
      if (this.status.sacn.failed.length > 0) {
        this.options.log?.warn(
          `sACN: could not join ${this.status.sacn.failed.map((f) => f.universe).join(', ')} — ` +
            'Linux allows 20 memberships per socket (net.ipv4.igmp_max_memberships)'
        )
      }
    })
  }
}

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
