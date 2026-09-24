import { createHash } from 'node:crypto'
import dgram from 'node:dgram'
import {
  TYPE_A,
  TYPE_ANY,
  TYPE_NSEC,
  TYPE_PTR,
  TYPE_SRV,
  TYPE_TXT,
  decodeMessage,
  encodeData,
  encodeMessage,
  labelBytes,
  sameName,
  truncateUtf8,
  type Message,
  type Name,
  type Question,
  type ResourceRecord,
} from './dns.ts'

/**
 * The box saying where it is, on the crew network, so the apps can list it.
 *
 * A multicast DNS responder (RFC 6762) for one DNS-SD service (RFC 6763),
 * `_crewbox._tcp`, the way printers and Dante gear announce themselves. It
 * claims its names by probing, announces them, answers the questions phones
 * ask, and says goodbye when it stops, so a phone's list drops the box
 * straight away rather than when its records time out.
 *
 * **It sends, so where it sends is the whole design.** The watchers' sockets
 * have `send` taken off them and stay that way; this is a separate socket,
 * opened only on the adapter the supervisor (./index.ts) has decided is the
 * crew network. Multicast leaves by that adapter alone, and a question from
 * anywhere else is not answered: a phone on the crew Wi-Fi asks from an
 * address on the crew adapter's subnet, and nothing else gets a word.
 *
 * What it says is what the join screen already shows anyone before sign-in:
 * the event's name and ID, the box's version, whether it has been set up,
 * and the name on its certificate. Never a PIN, a password or the Wi-Fi's.
 */

export const MDNS_PORT = 5353
export const MDNS_GROUP = '224.0.0.251'

/** The service type the apps browse for. */
export const SERVICE_TYPE: Name = ['_crewbox', '_tcp', 'local']
/** Where DNS-SD lists service types (RFC 6763 §9). */
const SERVICE_TYPES: Name = ['_services', '_dns-sd', '_udp', 'local']

/**
 * RFC 6762 §10: a record that names a host, or carries one in its data, lives
 * 120 s so a box that moves is followed quickly; everything else 75 minutes.
 */
const HOST_TTL = 120
const OTHER_TTL = 4500
/** Replies to a legacy (one-shot) question carry at most 10 s (RFC 6762 §6.7). */
const LEGACY_TTL = 10

/** RFC 6762 §8.1: three probes, 250 ms apart, the first after up to 250 ms. */
const PROBES = 3
const PROBE_GAP_MS = 250
/** RFC 6762 §8.3: at least two announcements, one second apart. */
const ANNOUNCEMENTS = 2
const ANNOUNCE_GAP_MS = 1000
/** RFC 6762 §6: a record goes out at most once a second, or four times while defending. */
const MULTICAST_GAP_MS = 1000
const DEFEND_GAP_MS = 250
/**
 * RFC 6762 §7.2: a question that says more known answers follow is answered
 * 400 to 500 ms after the last packet saying so.
 */
const TRUNCATED_WAIT_MS = 400
const TRUNCATED_JITTER_MS = 100
/** RFC 6762 §8.1: after fifteen conflicts in ten seconds, probe at most every five. */
const CONFLICT_BURST = 15
const CONFLICT_WINDOW_MS = 10_000
const CONFLICT_BACKOFF_MS = 5000
/** How long a record we sent is recognised when it comes back to us. */
const ECHO_MS = 5000

export interface ServiceDetails {
  /** The event's ID: its database's, minted once (see Store.dbEpoch). */
  eventId: string
  eventName: string
  version: string
  /** The wire protocol's generation (PROTOCOL_VERSION). */
  protocol: number
  /** Whether setup has been done; a new box is listed as not set up yet. */
  setUp: boolean
  /** Whether the crew port speaks TLS. */
  tls: boolean
  /** The name on the box's certificate: what an app must connect by. */
  tlsName?: string
}

export interface AnnouncerOptions {
  /** The crew adapter's IPv4 address. */
  address: string
  /** Its netmask, which says who is on the crew network. */
  netmask: string
  /** The port the crew reach the box on. */
  port: number
  /** Read each time something is sent, so a renamed event is said as it is now. */
  details: () => ServiceDetails
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
  /** Injectable for tests. */
  createSocket?: (options: dgram.SocketOptions) => dgram.Socket
  /** For tests only: 5353 is held by every responder on a machine. */
  mdnsPort?: number
  /** For tests: the source of the random delays RFC 6762 asks for. */
  random?: () => number
}

export type AnnouncerState = 'idle' | 'probing' | 'announced' | 'stopped' | 'failed'

/** The first six hex digits of the event ID's hash: a host name that is this event's and stays put. */
const hostTag = (eventId: string): string =>
  createHash('sha256').update(eventId).digest('hex').slice(0, 6)

/** Two records are the same record: name, type and data (RFC 6762 §6.1 ignores the TTL). */
function sameRecord(a: ResourceRecord, b: ResourceRecord): boolean {
  return (
    a.type === b.type && sameName(a.name, b.name) && encodeData(a.data).equals(encodeData(b.data))
  )
}

/**
 * Whether a query lists `record` among the answers its asker already holds,
 * with at least half its life left (RFC 6762 §7.1). Below half, the answer is
 * worth sending again, to refresh the asker's copy before it runs out.
 */
const holds = (query: Message, record: ResourceRecord): boolean =>
  query.answers.some((known) => sameRecord(known, record) && known.ttl >= record.ttl / 2)

const recordKey = (r: ResourceRecord): string =>
  `${r.name.join('.').toLowerCase()}|${r.type}|${encodeData(r.data).toString('hex')}`

const toInt = (ip: string): number =>
  ip.split('.').reduce((n, octet) => ((n << 8) | (Number(octet) & 255)) >>> 0, 0)

/** Whether `ip` is on the network `address`/`netmask` names. */
export function onNetwork(ip: string, address: string, netmask: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false
  const mask = toInt(netmask)
  return (toInt(ip) & mask) >>> 0 === (toInt(address) & mask) >>> 0
}

/**
 * RFC 6762 §8.2's order for two probes' records: class, then type, then the
 * data's bytes. Negative when `a` sorts first.
 */
function compareRecords(a: ResourceRecord, b: ResourceRecord): number {
  if (a.type !== b.type) return a.type - b.type
  return Buffer.compare(encodeData(a.data), encodeData(b.data))
}

interface Records {
  ptr: ResourceRecord
  types: ResourceRecord
  srv: ResourceRecord
  txt: ResourceRecord
  a: ResourceRecord
  hostTypes: ResourceRecord
  instanceTypes: ResourceRecord
}

/**
 * An answer waiting for the rest of a truncated question's known answers
 * (RFC 6762 §7.2), for one asker.
 */
interface Waiting {
  /** Who asked. What follows is matched by address, as §15.2 says. */
  from: dgram.RemoteInfo
  /** What it will be sent, less whatever the packets since say it holds. */
  answers: ResourceRecord[]
  /** Every question it asked wanted a unicast reply. */
  unicast: boolean
  /** It was probing for one of our names. */
  defending: boolean
  /** When to answer: 400 to 500 ms after the last packet saying more follow. */
  due: number
}

export class Announcer {
  private readonly options: AnnouncerOptions
  private readonly mdnsPort: number
  private readonly random: () => number
  private socket: dgram.Socket | null = null
  private current: AnnouncerState = 'idle'
  private timers = new Set<NodeJS.Timeout>()
  /**
   * What the box says, as of the last start or refresh. Read once rather than
   * per packet: a busy crew Wi-Fi is hundreds of mDNS questions a minute,
   * nearly all of them about somebody else.
   */
  private said: ServiceDetails | null = null
  private tag = ''
  private cache: { key: string; records: Records } | null = null
  private instanceNumber = 1
  private hostNumber = 1
  private readonly lastMulticast = new Map<string, number>()
  private conflicts: number[] = []
  /** Bumped whenever probing restarts, so a timer from an older round does nothing. */
  private round = 0
  /** Every record sent in the last few seconds, to recognise our own packets coming back. */
  private readonly sent = new Map<string, number>()
  /** Answers held back for the rest of a truncated question, by the asker's address. */
  private readonly waiting = new Map<string, Waiting>()

  constructor(options: AnnouncerOptions) {
    this.options = options
    this.mdnsPort = options.mdnsPort ?? MDNS_PORT
    this.random = options.random ?? Math.random
  }

  get state(): AnnouncerState {
    return this.current
  }

  /** What ended it, when something did after it started. */
  error: string | null = null

  /** The service instance's label: the event's name, numbered if another box has it. */
  get instanceName(): string {
    const base = this.said?.eventName.trim() || 'crewbox'
    if (this.instanceNumber === 1) return truncateUtf8(base, 63)
    const suffix = ` (${this.instanceNumber})`
    return `${truncateUtf8(base, 63 - labelBytes(suffix))}${suffix}`
  }

  /** The host label the SRV record points at. The box's own name is its OS's to use. */
  get hostName(): string {
    const tag = this.tag || hostTag(this.options.details().eventId)
    return this.hostNumber === 1 ? `crewbox-${tag}` : `crewbox-${tag}-${this.hostNumber}`
  }

  /**
   * Open the socket and start claiming the names. Rejects if the port cannot
   * be opened; the supervisor says why in the admin panel and tries again.
   */
  async start(): Promise<void> {
    if (this.current !== 'idle') return
    const create = this.options.createSocket ?? ((o) => dgram.createSocket(o))
    const socket = create({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('message', (buf, rinfo) => this.receive(buf, rinfo))
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.bind(this.mdnsPort, () => {
          socket.removeListener('error', reject)
          resolve()
        })
      })
      // A send that fails later (the adapter gone, the OS refusing) ends
      // this announcer. Not logged here: the supervisor starts another and
      // says why once, rather than every fifteen seconds for an event.
      socket.on('error', (err) => {
        this.error = err.message
        this.fail()
      })
      socket.addMembership(MDNS_GROUP, this.options.address)
      // Out of the crew adapter and no other, whatever the routing table
      // thinks of 224.0.0.0/4.
      socket.setMulticastInterface(this.options.address)
      // RFC 6762 §11: 255, so a receiver can tell the packet came from its
      // own link and was not forwarded to it.
      socket.setMulticastTTL(255)
      socket.setTTL(255)
      socket.setMulticastLoopback(true)
    } catch (err) {
      this.fail()
      throw err
    }
    this.take(this.options.details())
    this.probe()
  }

  private take(details: ServiceDetails): void {
    this.said = details
    this.tag = hostTag(details.eventId)
    this.cache = null
  }

  /**
   * Say what has changed. A renamed event is a new instance name, so the old
   * one says goodbye and the new one is probed for; anything else is
   * announced again in place, and the cache-flush bit replaces what phones
   * held.
   */
  refresh(): void {
    if (this.current !== 'announced' && this.current !== 'probing') return
    const before = this.said
    const old = this.records()
    const oldNames = this.names()
    const next = this.options.details()
    this.take(next)
    const renamed = before?.eventName.trim() !== next.eventName.trim()
    if (renamed) this.instanceNumber = 1
    const now = this.names()
    if (!sameName(now.instance, oldNames.instance) || !sameName(now.host, oldNames.host)) {
      // The old names go, so phones drop them now rather than in an hour.
      if (this.current === 'announced') {
        this.multicast(
          [old.ptr, old.srv, old.txt, old.a].map((r) => ({ ...r, ttl: 0 })),
          [],
          true
        )
      }
      this.probe()
      return
    }
    if (this.current === 'announced') this.announce()
  }

  /** Say goodbye (TTL 0, RFC 6762 §10.1) and close. */
  async stop(): Promise<void> {
    const socket = this.socket
    const wasAnnounced = this.current === 'announced'
    this.clearTimers()
    this.current = 'stopped'
    this.socket = null
    if (!socket) return
    if (wasAnnounced) {
      // Not the service-type record: another box may still offer the type.
      const { ptr, srv, txt, a } = this.records()
      const goodbye = encodeMessage({
        id: 0,
        response: true,
        questions: [],
        answers: [ptr, srv, txt, a].map((r) => ({ ...r, ttl: 0 })),
        authorities: [],
        additionals: [],
      })
      // Bounded: an update waits on this to let go of the box's ports, and a
      // goodbye nobody could send is not worth holding one up for.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500)
        try {
          socket.send(goodbye, this.mdnsPort, MDNS_GROUP, () => {
            clearTimeout(timer)
            resolve()
          })
        } catch {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    try {
      socket.close()
    } catch {
      // Already closed after an error.
    }
  }

  private fail(): void {
    this.clearTimers()
    this.current = 'failed'
    const socket = this.socket
    this.socket = null
    try {
      socket?.close()
    } catch {
      // Already closed.
    }
  }

  private later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      run()
    }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    // Their timers are gone, so they would never be sent.
    this.waiting.clear()
  }

  // -------------------------------------------------------------------------
  // The records

  private names(): { instance: Name; host: Name } {
    return {
      instance: [this.instanceName, ...SERVICE_TYPE],
      host: [this.hostName, 'local'],
    }
  }

  /** What the TXT record says. Keys are short, as RFC 6763 §6.4 asks. */
  private txtStrings(): Buffer[] {
    const d = this.said ?? this.options.details()
    const pairs = [
      'txtvers=1',
      `id=${d.eventId}`,
      // 255 bytes a string, less "name=".
      `name=${truncateUtf8(d.eventName.trim(), 250)}`,
      `ver=${truncateUtf8(d.version, 200)}`,
      `proto=${d.protocol}`,
      `setup=${d.setUp ? 1 : 0}`,
      ...(d.tls ? [d.tlsName ? `tls=${truncateUtf8(d.tlsName, 250)}` : 'tls'] : []),
    ]
    return pairs.map((p) => Buffer.from(p, 'utf8'))
  }

  private records(): Records {
    const key = `${this.instanceNumber}|${this.hostNumber}`
    if (this.cache?.key === key) return this.cache.records
    const records = this.build()
    this.cache = { key, records }
    return records
  }

  private build(): Records {
    const { instance, host } = this.names()
    const ptr: ResourceRecord = {
      name: SERVICE_TYPE,
      type: TYPE_PTR,
      cacheFlush: false,
      ttl: OTHER_TTL,
      data: { kind: 'ptr', target: instance },
    }
    const types: ResourceRecord = {
      name: SERVICE_TYPES,
      type: TYPE_PTR,
      cacheFlush: false,
      ttl: OTHER_TTL,
      data: { kind: 'ptr', target: SERVICE_TYPE },
    }
    const srv: ResourceRecord = {
      name: instance,
      type: TYPE_SRV,
      cacheFlush: true,
      ttl: HOST_TTL,
      data: { kind: 'srv', priority: 0, weight: 0, port: this.options.port, target: host },
    }
    const txt: ResourceRecord = {
      name: instance,
      type: TYPE_TXT,
      cacheFlush: true,
      ttl: OTHER_TTL,
      data: { kind: 'txt', strings: this.txtStrings() },
    }
    const a: ResourceRecord = {
      name: host,
      type: TYPE_A,
      cacheFlush: true,
      ttl: HOST_TTL,
      data: { kind: 'a', address: this.options.address },
    }
    // RFC 6762 §6.1: saying which types a name has, so a phone asking for an
    // IPv6 address it will never get stops waiting for one.
    const hostTypes: ResourceRecord = {
      name: host,
      type: TYPE_NSEC,
      cacheFlush: true,
      ttl: HOST_TTL,
      data: { kind: 'nsec', next: host, types: [TYPE_A] },
    }
    const instanceTypes: ResourceRecord = {
      name: instance,
      type: TYPE_NSEC,
      cacheFlush: true,
      ttl: HOST_TTL,
      data: { kind: 'nsec', next: instance, types: [TYPE_TXT, TYPE_SRV] },
    }
    return { ptr, types, srv, txt, a, hostTypes, instanceTypes }
  }

  /** The records that answer one question, or none. */
  private answersFor(q: Question): ResourceRecord[] {
    const r = this.records()
    const { instance, host } = this.names()
    const any = q.type === TYPE_ANY
    if (sameName(q.name, SERVICE_TYPE)) return any || q.type === TYPE_PTR ? [r.ptr] : []
    if (sameName(q.name, SERVICE_TYPES)) return any || q.type === TYPE_PTR ? [r.types] : []
    if (sameName(q.name, instance)) {
      if (any) return [r.srv, r.txt]
      if (q.type === TYPE_SRV) return [r.srv]
      if (q.type === TYPE_TXT) return [r.txt]
      return [r.instanceTypes]
    }
    if (sameName(q.name, host)) {
      if (any || q.type === TYPE_A) return [r.a]
      return [r.hostTypes]
    }
    return []
  }

  /**
   * What a phone will ask next, sent now (RFC 6763 §12): a service's name
   * brings its SRV, TXT and address; an SRV brings the address; an address
   * brings the word that there is no other.
   */
  private additionalsFor(answers: ResourceRecord[]): ResourceRecord[] {
    const r = this.records()
    const extra: ResourceRecord[] = []
    const add = (record: ResourceRecord) => {
      if (![...answers, ...extra].some((x) => sameRecord(x, record))) extra.push(record)
    }
    for (const answer of answers) {
      if (answer.type === TYPE_PTR && sameName(answer.name, SERVICE_TYPE)) {
        for (const record of [r.srv, r.txt, r.a, r.hostTypes]) add(record)
      } else if (answer.type === TYPE_SRV) {
        for (const record of [r.a, r.hostTypes]) add(record)
      } else if (answer.type === TYPE_A) {
        add(r.hostTypes)
      }
    }
    return extra
  }

  // -------------------------------------------------------------------------
  // Claiming the names

  private isOurs(name: Name): boolean {
    const { instance, host } = this.names()
    return sameName(name, instance) || sameName(name, host)
  }

  private probe(): void {
    this.clearTimers()
    this.current = 'probing'
    const round = ++this.round
    const now = Date.now()
    this.conflicts = this.conflicts.filter((t) => now - t < CONFLICT_WINDOW_MS)
    const first =
      this.conflicts.length >= CONFLICT_BURST
        ? CONFLICT_BACKOFF_MS
        : Math.floor(this.random() * PROBE_GAP_MS)
    let sent = 0
    const next = () => {
      if (round !== this.round || this.current !== 'probing') return
      if (sent === PROBES) {
        this.current = 'announced'
        this.options.log?.info(
          `bonjour: announcing "${this.instanceName}" on ${this.options.address}`
        )
        this.announce()
        return
      }
      sent++
      this.sendProbe()
      this.later(PROBE_GAP_MS, next)
    }
    this.later(first, next)
  }

  private sendProbe(): void {
    const { instance, host } = this.names()
    const { srv, txt, a } = this.records()
    // The records we would claim go in the authority section, without the
    // cache-flush bit, which belongs to responses (RFC 6762 §8.1, §10.2).
    //
    // The questions ask for a multicast defence, not the unicast one §8.1
    // suggests. Port 5353 is shared with the machine's own responder, and a
    // unicast packet to it reaches one socket only (§15.1): mDNSResponder's
    // on a Mac, an unpredictable one on Windows, usually the newest on
    // Linux. A defender answering by unicast would tell the OS's responder,
    // and the box would take a name somebody has. Multicast reaches every
    // socket on the port. §15.1 asks this of a responder that is not the
    // first on the port, and on a Mac or Windows the box never is.
    this.send({
      id: 0,
      response: false,
      questions: [
        { name: instance, type: TYPE_ANY, unicast: false },
        { name: host, type: TYPE_ANY, unicast: false },
      ],
      answers: [],
      authorities: [srv, txt, a].map((r) => ({ ...r, cacheFlush: false })),
      additionals: [],
    })
  }

  private announce(): void {
    const round = this.round
    let sent = 0
    const next = () => {
      if (round !== this.round || this.current !== 'announced') return
      const { ptr, types, srv, txt, a } = this.records()
      this.multicast([ptr, types, srv, txt, a], [], true)
      if (++sent < ANNOUNCEMENTS) this.later(ANNOUNCE_GAP_MS, next)
    }
    next()
  }

  /** Somebody else has one of our names: take the next number and claim again. */
  private conflict(which: 'instance' | 'host'): void {
    this.conflicts.push(Date.now())
    if (which === 'instance') this.instanceNumber++
    else this.hostNumber++
    this.options.log?.info(
      `bonjour: another device on the crew network has that name, trying "${
        which === 'instance' ? this.instanceName : this.hostName
      }"`
    )
    this.probe()
  }

  // -------------------------------------------------------------------------
  // Listening

  private receive(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    // Only the crew network gets an answer, or a hearing.
    if (!onNetwork(rinfo.address, this.options.address, this.options.netmask)) return
    const message = decodeMessage(buf)
    if (!message) return
    if (message.response) this.onResponse(message)
    else this.onQuery(message, rinfo)
  }

  /**
   * Somebody else's answers. A record under one of our names with other data
   * means the name is taken (RFC 6762 §8.1 while probing, §9 afterwards).
   * Our own announcements come back to us too, and match exactly.
   */
  private onResponse(message: Message): void {
    if (this.current !== 'probing' && this.current !== 'announced') return
    const r = this.records()
    const { instance, host } = this.names()
    const ours = [r.srv, r.txt, r.a, r.hostTypes, r.instanceTypes]
    for (const record of [...message.answers, ...message.additionals]) {
      if (record.ttl === 0) continue
      const onInstance = sameName(record.name, instance)
      const onHost = sameName(record.name, host)
      if (!onInstance && !onHost) continue
      if (this.echo(record) || ours.some((mine) => sameRecord(mine, record))) continue
      // While probing any record of the name is a claim on it; once it is
      // ours, only a different record of a type we hold is a conflict.
      if (
        this.current === 'probing' ||
        ours.some((mine) => mine.type === record.type && sameName(mine.name, record.name))
      ) {
        this.conflict(onInstance ? 'instance' : 'host')
        return
      }
    }
  }

  private onQuery(message: Message, rinfo: dgram.RemoteInfo): void {
    if (this.current === 'probing') {
      this.tieBreak(message)
      return
    }
    if (this.current !== 'announced') return

    // The rest of a truncated question's known answers (RFC 6762 §7.2): what
    // they list comes off the answer held for that asker, and one that says
    // still more follow puts the answer back until 400 to 500 ms after it.
    // They come with no questions of their own, so this is all they get.
    const held = this.waiting.get(rinfo.address)
    if (held) {
      held.answers = held.answers.filter((record) => !holds(message, record))
      if (message.truncated) held.due = Math.max(held.due, Date.now() + this.truncatedWait())
    }

    const answers: ResourceRecord[] = []
    for (const question of message.questions) {
      for (const record of this.answersFor(question)) {
        if (!answers.some((x) => sameRecord(x, record))) answers.push(record)
      }
    }
    // Known-answer suppression (RFC 6762 §7.1): nothing the asker already
    // holds with at least half its life left.
    const fresh = answers.filter((record) => !holds(message, record))
    if (fresh.length === 0) return

    // A one-shot question from a port other than 5353 (RFC 6762 §6.7): a
    // unicast reply to that port, the question repeated, short TTLs, and no
    // cache-flush bits, which such a resolver would not understand.
    if (rinfo.port !== this.mdnsPort) {
      const legacy = (r: ResourceRecord): ResourceRecord => ({
        ...r,
        cacheFlush: false,
        ttl: Math.min(r.ttl, LEGACY_TTL),
      })
      this.send(
        {
          id: message.id,
          response: true,
          questions: message.questions,
          answers: fresh.map(legacy),
          authorities: [],
          additionals: this.additionalsFor(fresh).map(legacy),
        },
        rinfo
      )
      return
    }

    // A probe for one of our names: defend it at once (RFC 6762 §8.1).
    const defending = message.authorities.some((r) => this.isOurs(r.name))
    const unicast = message.questions.length > 0 && message.questions.every((q) => q.unicast)

    // A truncated question waits for the rest of the asker's known answers
    // (RFC 6762 §7.2). A second one from the same asker joins the first.
    if (message.truncated) {
      if (held) {
        for (const record of fresh) {
          if (!held.answers.some((x) => sameRecord(x, record))) held.answers.push(record)
        }
        held.unicast &&= unicast
        held.defending ||= defending
        return
      }
      const waiting: Waiting = {
        from: rinfo,
        answers: fresh,
        unicast,
        defending,
        due: Date.now() + this.truncatedWait(),
      }
      this.waiting.set(rinfo.address, waiting)
      this.awaitRest(waiting, this.round)
      return
    }

    // RFC 6762 §6: a shared record waits 20-120 ms, so answers from several
    // devices spread out; a unique one goes at once, which is also how a
    // name is defended, since only unique records are probed for.
    const shared = fresh.some((r) => !r.cacheFlush)
    const round = this.round
    const reply = () => {
      if (round !== this.round || this.current !== 'announced') return
      this.reply(fresh, unicast, defending, rinfo)
    }
    if (shared) this.later(20 + Math.floor(this.random() * 100), reply)
    else reply()
  }

  private truncatedWait(): number {
    return TRUNCATED_WAIT_MS + Math.floor(this.random() * TRUNCATED_JITTER_MS)
  }

  /** Answer a truncated question once its asker has gone quiet. */
  private awaitRest(waiting: Waiting, round: number): void {
    this.later(Math.max(0, waiting.due - Date.now()), () => {
      if (round !== this.round || this.current !== 'announced') return
      // Put back by a packet that said still more follow.
      if (Date.now() < waiting.due) {
        this.awaitRest(waiting, round)
        return
      }
      if (this.waiting.get(waiting.from.address) === waiting) {
        this.waiting.delete(waiting.from.address)
      }
      if (waiting.answers.length > 0) {
        this.reply(waiting.answers, waiting.unicast, waiting.defending, waiting.from)
      }
    })
  }

  /**
   * Send the answers to a question, with what the asker will want next. By
   * unicast only to a question that asked for it, about records multicast
   * within the last quarter of their life (RFC 6762 §5.4); otherwise by
   * multicast, each record at most once a second, or four times a second
   * while defending a name (§6).
   */
  private reply(
    answers: ResourceRecord[],
    askedUnicast: boolean,
    defending: boolean,
    to: dgram.RemoteInfo
  ): void {
    const additionals = this.additionalsFor(answers)
    const now = Date.now()
    const unicast =
      askedUnicast &&
      answers.every((r) => now - (this.lastMulticast.get(recordKey(r)) ?? -Infinity) < r.ttl * 250)
    if (unicast) {
      this.send({ id: 0, response: true, questions: [], answers, authorities: [], additionals }, to)
    } else {
      this.multicast(answers, additionals, false, defending ? DEFEND_GAP_MS : MULTICAST_GAP_MS)
    }
  }

  /**
   * Two hosts probing for one name at once (RFC 6762 §8.2): compare the
   * records each would claim, and the one that sorts first backs off for a
   * second and probes again. Identical records are our own probe coming back.
   */
  private tieBreak(message: Message): void {
    const r = this.records()
    const { instance, host } = this.names()
    for (const [name, mine] of [
      [instance, [r.srv, r.txt]],
      [host, [r.a]],
    ] as const) {
      const theirs = message.authorities.filter((x) => sameName(x.name, name))
      // Our own probe, back from the network: every record in it is one we
      // sent a moment ago. Anything else is compared whole, identical
      // records included, as §8.2.1 compares them.
      if (theirs.length === 0 || theirs.every((x) => this.echo(x))) continue
      const a = [...mine].sort(compareRecords)
      const b = [...theirs].sort(compareRecords)
      let order = 0
      for (let i = 0; i < Math.min(a.length, b.length) && order === 0; i++) {
        order = compareRecords(a[i]!, b[i]!)
      }
      if (order === 0) order = a.length - b.length
      if (order < 0) {
        const round = ++this.round
        this.clearTimers()
        this.later(1000, () => {
          if (round === this.round) this.probe()
        })
        return
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sending

  private send(message: Omit<Message, 'truncated'>, to?: dgram.RemoteInfo): void {
    const socket = this.socket
    if (!socket) return
    const now = Date.now()
    for (const [key, at] of this.sent) if (now - at > ECHO_MS) this.sent.delete(key)
    for (const r of [...message.answers, ...message.authorities, ...message.additionals]) {
      this.sent.set(recordKey(r), now)
    }
    try {
      const buf = encodeMessage(message)
      if (to) socket.send(buf, to.port, to.address)
      else socket.send(buf, this.mdnsPort, MDNS_GROUP)
    } catch (err) {
      this.options.log?.warn(`bonjour: could not send (${String(err)})`)
    }
  }

  /**
   * Whether a record is one this box sent a moment ago. Multicast comes back
   * to the socket that sent it, and an announcement that arrives after the
   * box renamed itself would otherwise read as somebody else's claim.
   */
  private echo(record: ResourceRecord): boolean {
    const at = this.sent.get(recordKey(record))
    return at !== undefined && Date.now() - at <= ECHO_MS
  }

  /**
   * Multicast records, each no more often than `gap` allows (RFC 6762 §6).
   * Announcements and goodbyes are sent whole, `force` skipping the check.
   */
  private multicast(
    answers: ResourceRecord[],
    additionals: ResourceRecord[],
    force: boolean,
    gap = MULTICAST_GAP_MS
  ): void {
    const now = Date.now()
    const due = force
      ? answers
      : answers.filter((r) => now - (this.lastMulticast.get(recordKey(r)) ?? -Infinity) >= gap)
    if (due.length === 0) return
    for (const r of due) this.lastMulticast.set(recordKey(r), now)
    this.send({
      id: 0,
      response: true,
      questions: [],
      answers: due,
      authorities: [],
      additionals: additionals.filter((x) => !due.some((y) => sameRecord(x, y))),
    })
  }
}
