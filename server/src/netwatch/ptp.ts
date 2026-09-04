/**
 * PTP (Precision Time Protocol), receive side only — the clock that every
 * audio-over-IP network stands on.
 *
 * Dante, AES67 and RAVENNA all distribute time with PTP, and clock trouble
 * is *the* audio-network failure mode: a grandmaster election war sounds
 * like clicks and dropouts on every device at once, and nothing on a mixing
 * desk says why. The election traffic is multicast (224.0.1.129), so a
 * read-only socket can watch it happen: who is grandmaster, whether that
 * has been changing, and how steadily the messages arrive.
 *
 * Two generations matter on a real stage:
 *
 * - **PTPv2** (IEEE 1588-2008) — AES67, RAVENNA, Dante in AES67 mode. The
 *   Announce message carries the full grandmaster identity and priority
 *   set, and this parser decodes it completely.
 * - **PTPv1** (IEEE 1588-2002) — classic Dante clocking. Its wire format is
 *   decoded here only as far as "version 1, this message type, this
 *   subdomain": the grandmaster fields exist in v1 Sync messages, but this
 *   codebase has never seen a captured Dante packet to verify offsets
 *   against, and a confidently mis-parsed clock identity is worse than a
 *   counted presence. So v1 is reported as presence and rate — which still
 *   answers "is Dante clocking on this network and is it steady" — and the
 *   full decode is deliberately left until real captures exist (the same
 *   rule the DMX layer applied before it, docs/DMX_MONITORING.md).
 *
 * Nothing here transmits, and the listener strips `send` off the sockets
 * before use — same mechanism, same reason as the DMX listener.
 */

/** Event messages (Sync, Delay_Req) arrive here... */
export const PTP_EVENT_PORT = 319
/** ...and general messages (Announce, Follow_Up) here. */
export const PTP_GENERAL_PORT = 320

/** The default-domain multicast group both PTP generations use. */
export const PTP_GROUP = '224.0.1.129'

/** PTPv2 message types (header byte 0, low nibble). */
const V2_SYNC = 0x0
const V2_ANNOUNCE = 0xb

export interface PtpAnnounce {
  version: 2
  kind: 'announce'
  domain: number
  /** EUI-64 as hex pairs, e.g. "00:1d:c1:ff:fe:12:34:56". */
  grandmasterId: string
  priority1: number
  priority2: number
  clockClass: number
  stepsRemoved: number
  /** The sender of this announce, not necessarily the grandmaster. */
  sourceId: string
  sequenceId: number
}

export interface PtpSync {
  version: 2
  kind: 'sync'
  domain: number
  sourceId: string
}

/** A PTPv1 message: presence, honestly undecoded beyond the header. */
export interface PtpV1Message {
  version: 1
  kind: 'v1'
  /** v1 control field: 0 Sync, 1 Delay_Req, 2 Follow_Up, 3 Delay_Resp. */
  control: number
}

export type PtpMessage = PtpAnnounce | PtpSync | PtpV1Message

const hexId = (buf: Buffer, start: number, length: number): string =>
  [...buf.subarray(start, start + length)].map((b) => b.toString(16).padStart(2, '0')).join(':')

/**
 * Parse one datagram from either PTP port. Returns null for anything that
 * is not PTP — the group also carries other IGMP-era chatter on some
 * networks, and junk must not become a grandmaster.
 */
export function parsePtp(buf: Buffer): PtpMessage | null {
  if (buf.length < 34) return null

  const version = buf[1]! & 0x0f

  if (version === 2) {
    const type = buf[0]! & 0x0f
    const length = buf.readUInt16BE(2)
    if (length > buf.length) return null
    const domain = buf[4]!
    const sourceId = hexId(buf, 20, 8)

    if (type === V2_ANNOUNCE) {
      // Announce body follows the 34-byte header: originTimestamp (10),
      // currentUtcOffset (2), reserved (1), then the grandmaster block.
      if (buf.length < 64) return null
      return {
        version: 2,
        kind: 'announce',
        domain,
        priority1: buf[47]!,
        clockClass: buf[48]!,
        priority2: buf[52]!,
        grandmasterId: hexId(buf, 53, 8),
        stepsRemoved: buf.readUInt16BE(61),
        sourceId,
        sequenceId: buf.readUInt16BE(30),
      }
    }
    if (type === V2_SYNC) {
      return { version: 2, kind: 'sync', domain, sourceId }
    }
    return null
  }

  if (version === 1) {
    // IEEE 1588-2002: bytes 0-1 are versionPTP as a big-endian u16, so a
    // v1 packet reads 0x0001 there. The control byte at 32 names the
    // message type. Everything deeper is deliberately not decoded — see
    // the header comment for why.
    if (buf.readUInt16BE(0) !== 1) return null
    return { version: 1, kind: 'v1', control: buf[32]! }
  }

  return null
}

/** How long a grandmaster may go quiet before its reign is over. Announce
 *  intervals are typically 1-2 s; 10 s is several missed in a row. */
export const GRANDMASTER_TIMEOUT_MS = 10_000

/** Changes inside this window are what "unstable" means on the panel. */
export const CLOCK_HISTORY_MS = 10 * 60_000

export interface ClockChange {
  at: number
  from: string | null
  to: string
}

export interface ClockStatus {
  /** Current v2 grandmaster, or null when none is announcing. */
  grandmasterId: string | null
  domain: number | null
  /**
   * How many PTP domains are announcing at once.
   *
   * A domain is a separate clock tree that shares the wire — Dante on 0 and
   * a video reference on 127 is an ordinary rig, not a fault. The ledger
   * used to keep one grandmaster across all of them, so two perfectly
   * stable domains looked like two clocks trading the crown several times
   * a second: the panel called it an election war for a network where
   * nothing was wrong at all. Everything below describes the busiest
   * domain; this says how many there are.
   */
  domains: number
  priority1: number | null
  clockClass: number | null
  /** When the current grandmaster's reign began. */
  since: number | null
  lastAnnounce: number | null
  /** Grandmaster changes in the last CLOCK_HISTORY_MS, newest first. */
  changes: ClockChange[]
  /** Distinct v2 clocks heard announcing recently — 2+ means an election. */
  announcers: number
  /** PTPv1 (classic Dante) presence: messages per second, last second. */
  v1RateHz: number
  v1Seen: boolean
}

/**
 * The grandmaster ledger: who holds the clock, since when, and how often it
 * has changed hands. Pure — frames and clocks in, judgement out — so every
 * election war is a unit test rather than a rig.
 */
interface DomainLedger {
  grandmasterId: string | null
  priority1: number | null
  clockClass: number | null
  since: number | null
  lastAnnounce: number
  changes: ClockChange[]
  /** v2 clock id → last time it announced, for the election count. */
  announcers: Map<string, number>
}

/**
 * A domain that has never announced this session.
 *
 * `lastAnnounce: 0` rather than null so the sweep's arithmetic is total —
 * a fresh ledger is only ever created by an arriving announce anyway.
 */
const emptyDomain = (): DomainLedger => ({
  grandmasterId: null,
  priority1: null,
  clockClass: null,
  since: null,
  lastAnnounce: 0,
  changes: [],
  announcers: new Map(),
})

export class PtpState {
  /** One ledger per PTP domain — see ClockStatus.domains. */
  private readonly domains = new Map<number, DomainLedger>()
  private v1Packets = 0
  private v1WindowStart = 0
  private v1RateHz = 0
  private v1LastSeen = 0

  apply(message: PtpMessage, now: number): void {
    if (message.version === 1) {
      this.v1LastSeen = now
      if (this.v1WindowStart === 0) this.v1WindowStart = now
      this.v1Packets++
      if (now - this.v1WindowStart >= 1000) {
        this.v1RateHz = Math.round((this.v1Packets * 1000) / (now - this.v1WindowStart))
        this.v1Packets = 0
        this.v1WindowStart = now
      }
      return
    }
    if (message.kind !== 'announce') return

    let ledger = this.domains.get(message.domain)
    if (!ledger) {
      ledger = emptyDomain()
      this.domains.set(message.domain, ledger)
    }
    ledger.announcers.set(message.grandmasterId, now)
    ledger.lastAnnounce = now
    ledger.priority1 = message.priority1
    ledger.clockClass = message.clockClass

    if (message.grandmasterId !== ledger.grandmasterId) {
      // The best-master election has moved the clock. Only counted as a
      // *change* when there was a previous holder to take it from: the
      // first announce this box hears is the clock it arrived to, not a
      // clock that moved, and recording it meant every start reported "the
      // clock is moving" for ten minutes. `since` carries when the reign
      // began, which is the thing that was worth knowing.
      if (ledger.grandmasterId !== null) {
        ledger.changes.unshift({ at: now, from: ledger.grandmasterId, to: message.grandmasterId })
      }
      ledger.grandmasterId = message.grandmasterId
      ledger.since = now
    }
  }

  /** The domain doing the most talking — what `status()` describes. */
  private busiest(): { domain: number; ledger: DomainLedger } | null {
    let best: { domain: number; ledger: DomainLedger } | null = null
    for (const [domain, ledger] of this.domains) {
      if (!best || ledger.lastAnnounce > best.ledger.lastAnnounce) best = { domain, ledger }
    }
    return best
  }

  /** Age out silence. Call on a timer, like DmxState.sweep. */
  sweep(now: number): void {
    for (const [domain, ledger] of this.domains) {
      if (now - ledger.lastAnnounce > GRANDMASTER_TIMEOUT_MS && ledger.grandmasterId !== null) {
        // Not recorded as a change: silence is its own state, and counting
        // it as churn would report a powered-down rig as an election war.
        ledger.grandmasterId = null
        ledger.since = null
      }
      for (const [id, seen] of ledger.announcers) {
        if (now - seen > GRANDMASTER_TIMEOUT_MS) ledger.announcers.delete(id)
      }
      ledger.changes = ledger.changes.filter((change) => now - change.at <= CLOCK_HISTORY_MS)
      // A domain that has been silent for longer than the whole history
      // window has nothing left to say and is forgotten, so a network that
      // cycles through domains does not accrete ledgers for ever.
      if (
        ledger.grandmasterId === null &&
        ledger.announcers.size === 0 &&
        ledger.changes.length === 0 &&
        now - ledger.lastAnnounce > CLOCK_HISTORY_MS
      ) {
        this.domains.delete(domain)
      }
    }
    if (this.v1LastSeen !== 0 && now - this.v1LastSeen > GRANDMASTER_TIMEOUT_MS) {
      this.v1RateHz = 0
    }
  }

  status(now: number): ClockStatus {
    const best = this.busiest()
    return {
      grandmasterId: best?.ledger.grandmasterId ?? null,
      domain: best?.domain ?? null,
      domains: this.domains.size,
      priority1: best?.ledger.priority1 ?? null,
      clockClass: best?.ledger.clockClass ?? null,
      since: best?.ledger.since ?? null,
      lastAnnounce: best?.ledger.lastAnnounce || null,
      changes: best ? [...best.ledger.changes] : [],
      announcers: best?.ledger.announcers.size ?? 0,
      v1RateHz: this.v1RateHz,
      v1Seen: this.v1LastSeen !== 0 && now - this.v1LastSeen <= GRANDMASTER_TIMEOUT_MS,
    }
  }

  clear(): void {
    this.domains.clear()
    this.v1Packets = 0
    this.v1WindowStart = 0
    this.v1RateHz = 0
    this.v1LastSeen = 0
  }
}
