import type { DecodedPtp } from '@crewbox/st2110'

/**
 * The video clock: PTP as SMPTE ST 2059-2 runs it, overheard.
 *
 * ST 2110 video and audio count their timestamps in PTP time, as AES67 does,
 * but under SMPTE's own profile: domain 127 by default, messages several
 * times faster (four Announce and eight Sync a second), a grandmaster locked
 * to its reference, and once a second a Management message of
 * synchronization metadata — the system frame rate, whether the grandmaster
 * is locked, the local time zone and the daily time code jam. A camera
 * running at the wrong rate, or time code an hour out, starts here.
 *
 * What breaks the profile is legofsalmon/st2110's to decide (its decodePtp);
 * this keeps what it says about each domain that runs the profile. A domain
 * runs it when it is the profile's default, 127, or when synchronization
 * metadata is sent on it. The AES67 media profile sends more slowly, on
 * domain 0 by default, and holding Dante's clock to the video profile would
 * call every audio rig broken.
 *
 * The messages come off the media watcher's receive-only sockets: nothing
 * here sends anything either.
 */

/** ST 2059-2's default domain. */
export const VIDEO_DOMAIN = 127

/** PTPv2 message types (header byte 0, low nibble) worth decoding. */
const SYNC = 0x0
const FOLLOW_UP = 0x8
const DELAY_RESP = 0x9
const ANNOUNCE = 0xb
const MANAGEMENT = 0xd
const CHECKED = new Set([SYNC, FOLLOW_UP, DELAY_RESP, ANNOUNCE, MANAGEMENT])

/**
 * One message of each type from each clock a second is plenty: the fields
 * checked change when somebody changes a setting, not from one Sync to the
 * next. Followers' Delay_Req, multicast from every device in the default
 * mode, are never decoded at all.
 */
export const DECODE_EVERY_MS = 1000

/**
 * Clock × domain × message type combinations the rate limit keeps track of.
 * A real rig has a handful; beyond this, new ones wait for the sweep, so a
 * flood of made-up clocks cannot turn into a flood of decoding.
 */
export const MAX_SENDERS = 512

/** A finding not repeated for this long has been fixed, or its sender is gone. */
export const FINDING_TIMEOUT_MS = 30_000

/** A domain silent this long is forgotten; the PTP watcher has said so already. */
export const DOMAIN_TIMEOUT_MS = 60_000

export interface VideoClockFinding {
  rule: string
  severity: 'error' | 'warning' | 'info'
  message: string
  /** The message it was found in: "Sync", "Announce", "Management". */
  messageType: string
  /** The clock that sent the message, as "08:00:11:ff:fe:21:e1:b0". */
  source: string
  lastSeen: number
}

export interface SyncMetadataFacts {
  /** defaultSystemFrameRate as sent: "30000/1001", "50/1". */
  frameRate: string
  dropFrame: boolean
  /** "externally locked", "internal", "cold locking" and so on. */
  locking: string
  /** Seconds from PTP time to local time (currentLocalOffset). */
  localOffset: number
  lastSeen: number
}

export interface VideoClockDomain {
  domain: number
  /** From the latest Announce; null until one has been heard. */
  grandmaster: string | null
  clockClass: number | null
  /** The ptpTimescale flag: PTP (TAI) time, rather than an arbitrary timescale. */
  ptpTimescale: boolean | null
  /** TAI − UTC in seconds, when the grandmaster marks it valid. */
  utcOffset: number | null
  metadata: SyncMetadataFacts | null
  /** One per rule, the latest: errors, then warnings, then notes. */
  findings: VideoClockFinding[]
  lastHeard: number
}

export interface VideoClockOptions {
  /**
   * Decodes and checks one message, or answers null when the checks are not
   * loaded yet. Injected, as SapOptions.check is; the listener passes the
   * real one.
   */
  decode?: (message: Uint8Array) => DecodedPtp | null
}

interface Ledger extends Omit<VideoClockDomain, 'domain' | 'findings'> {
  findings: Map<string, VideoClockFinding>
  /** Synchronization metadata has been sent on it: a video domain, whatever its number. */
  named: boolean
}

/** The wire's "08-00-11-FF-FE-21-E1-B0" as the PTP watcher writes ids. */
const clockId = (id: string): string => id.toLowerCase().replaceAll('-', ':')

const RANK = { error: 0, warning: 1, info: 2 } as const

export class VideoClockState {
  private readonly domains = new Map<number, Ledger>()
  /** Clock, domain and message type → when one was last decoded. */
  private readonly decoded = new Map<string, number>()
  private readonly decode: VideoClockOptions['decode']

  constructor(options: VideoClockOptions = {}) {
    this.decode = options.decode
  }

  private isVideo(domain: number): boolean {
    return domain === VIDEO_DOMAIN || this.domains.get(domain)?.named === true
  }

  /** Takes every datagram from both PTP ports, and looks at the few that matter. */
  apply(buf: Uint8Array, now: number): void {
    if (!this.decode || buf.length < 34 || (buf[1]! & 0x0f) !== 2) return
    const type = buf[0]! & 0x0f
    if (!CHECKED.has(type)) return
    const domain = buf[4]!
    // Synchronization metadata makes any domain a video one, so Management
    // messages are looked at on every domain, and the rest only on those.
    if (type !== MANAGEMENT && !this.isVideo(domain)) return

    // sourcePortIdentity: the clock and its port.
    const key = `${domain}/${type}/${Buffer.from(buf.subarray(20, 30)).toString('hex')}`
    const last = this.decoded.get(key)
    if (last !== undefined && now - last < DECODE_EVERY_MS) return
    if (last === undefined && this.decoded.size >= MAX_SENDERS) return
    this.decoded.set(key, now)

    let result: DecodedPtp | null
    try {
      result = this.decode(buf)
    } catch {
      return // not PTP after all, or cut short: the PTP watcher counts those
    }
    if (!result) return

    const { header, body, tlvs } = result.message
    const metadata = tlvs.find((t) => t.content.kind === 'sync_metadata')?.content
    if (!metadata && !this.isVideo(domain)) return
    let ledger = this.domains.get(domain)
    if (!ledger) {
      ledger = {
        grandmaster: null,
        clockClass: null,
        ptpTimescale: null,
        utcOffset: null,
        metadata: null,
        findings: new Map(),
        lastHeard: now,
        named: false,
      }
      this.domains.set(domain, ledger)
    }
    ledger.lastHeard = now
    if (metadata?.kind === 'sync_metadata') {
      ledger.named = true
      ledger.metadata = {
        frameRate: `${metadata.frame_rate_numerator}/${metadata.frame_rate_denominator}`,
        // timeAddressFlags bit 0: drop-frame time code.
        dropFrame: (metadata.time_address_flags & 1) !== 0,
        locking: metadata.locking_status,
        localOffset: metadata.current_local_offset,
        lastSeen: now,
      }
    }
    if (body.type === 'announce') {
      ledger.grandmaster = clockId(body.grandmaster)
      ledger.clockClass = body.quality.class
      ledger.ptpTimescale = header.flags.includes('PTP timescale')
      ledger.utcOffset = header.flags.includes('UTC offset valid') ? body.current_utc_offset : null
    }
    const source = clockId(header.source.clock)
    for (const finding of result.findings) {
      ledger.findings.set(finding.rule, {
        rule: finding.rule,
        severity: finding.severity,
        message: finding.message,
        messageType: header.message_type,
        source,
        lastSeen: now,
      })
    }
  }

  /** Age out what has stopped. Call on a timer, like PtpState.sweep. */
  sweep(now: number): void {
    for (const [key, at] of this.decoded) {
      if (now - at >= DECODE_EVERY_MS) this.decoded.delete(key)
    }
    for (const [domain, ledger] of this.domains) {
      if (now - ledger.lastHeard > DOMAIN_TIMEOUT_MS) {
        this.domains.delete(domain)
        continue
      }
      for (const [rule, finding] of ledger.findings) {
        if (now - finding.lastSeen > FINDING_TIMEOUT_MS) ledger.findings.delete(rule)
      }
      if (ledger.metadata && now - ledger.metadata.lastSeen > FINDING_TIMEOUT_MS) {
        ledger.metadata = null
      }
    }
  }

  /** The video domains heard, lowest first. */
  status(): VideoClockDomain[] {
    return [...this.domains]
      .sort(([a], [b]) => a - b)
      .map(([domain, { named: _named, findings, ...ledger }]) => ({
        domain,
        ...ledger,
        findings: [...findings.values()].sort(
          (a, b) => RANK[a.severity] - RANK[b.severity] || a.rule.localeCompare(b.rule)
        ),
      }))
  }

  clear(): void {
    this.domains.clear()
    this.decoded.clear()
  }
}

// --- What the panels say ------------------------------------------------------

/**
 * Findings that make the clock 'limited': every error, and a wrong UTC offset,
 * which the checks call a warning because video still locks — but time code
 * and every clock on the rig are then out by the difference.
 */
export const isFault = (f: VideoClockFinding): boolean =>
  f.severity === 'error' || f.rule === 'utc-offset'

/**
 * Findings the panel says in other words, or not at all: the grandmaster's
 * class and timescale are in its description, and an unknown accuracy is
 * what nearly every grandmaster without GPS announces. A free-running
 * grandmaster is fine for a rig that takes all its time from it.
 */
const DESCRIBED = new Set(['gm-clock-class', 'arb-timescale', 'clock-accuracy'])

export const isWorthALook = (f: VideoClockFinding): boolean =>
  !isFault(f) && f.severity !== 'info' && !DESCRIBED.has(f.rule)

/** What a grandmaster's clockClass says, in a word or two (IEEE 1588 §7.6.2.4). */
const CLASS_WORDS: Record<number, string> = {
  6: 'locked',
  13: 'locked',
  7: 'in holdover',
  14: 'in holdover',
  52: 'out of holdover specification',
  58: 'out of holdover specification',
  187: 'out of holdover specification',
  193: 'out of holdover specification',
  248: 'free-running',
}

const classWords = (clockClass: number): string =>
  CLASS_WORDS[clockClass]
    ? `${CLASS_WORDS[clockClass]} (class ${clockClass})`
    : `class ${clockClass}`

/** "29.97 fps drop-frame", "50 fps". */
function rateWords(metadata: SyncMetadataFacts): string {
  const [numerator, denominator] = metadata.frameRate.split('/').map(Number) as [number, number]
  const fps = numerator / denominator
  if (!Number.isFinite(fps) || fps <= 0) return `frame rate ${metadata.frameRate}`
  const rate = denominator === 1 ? String(numerator) : fps.toFixed(2).replace(/\.?0+$/, '')
  return `${rate} fps${metadata.dropFrame ? ' drop-frame' : ''}`
}

/** "UTC+01:00", "UTC-05:30", "UTC". */
function zoneWords(seconds: number): string {
  const minutes = Math.round(Math.abs(seconds) / 60)
  if (minutes === 0) return 'UTC'
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return `UTC${seconds < 0 ? '-' : '+'}${hh}:${mm}`
}

/**
 * One video domain in a sentence: "Domain 127: grandmaster 08:00:11:21:E1:B0,
 * locked (class 6); 29.97 fps drop-frame, externally locked, local time
 * UTC+01:00". `shortId` is the media panel's own.
 */
export function describeDomain(d: VideoClockDomain, shortId: (id: string) => string): string {
  const clock = d.grandmaster
    ? `grandmaster ${shortId(d.grandmaster)}` +
      (d.clockClass !== null ? `, ${classWords(d.clockClass)}` : '') +
      (d.ptpTimescale === false ? ', on an arbitrary timescale' : '')
    : 'no Announce heard yet'
  const metadata = d.metadata
    ? // Local time is PTP time plus the offset, and PTP time runs TAI − UTC
      // ahead of UTC: 37 s since 2017, when the grandmaster does not say.
      `${rateWords(d.metadata)}, ${d.metadata.locking}, local time ` +
      zoneWords(d.metadata.localOffset + (d.utcOffset ?? 37))
    : 'no synchronization metadata'
  return `Domain ${d.domain}: ${clock}; ${metadata}`
}

/** "Sync from 08:00:11:21:E1:B0: logMessageInterval is 0 (one a second), outside −7 to −1". */
export const findingWords = (f: VideoClockFinding, shortId: (id: string) => string): string =>
  `${f.messageType} from ${shortId(f.source)}: ${f.message}`

/** What to do about the first fault, by what kind of fault it is. */
export function faultFix(f: VideoClockFinding): string {
  if (f.rule === 'utc-offset') {
    return "Set the grandmaster's UTC offset to 37 s, or lock it to GPS: time code and every clock on the rig are out by the difference."
  }
  if (f.rule.startsWith('sm-')) {
    return "Check the grandmaster's time code settings: frame rate, time zone and daily jam."
  }
  return 'Set the grandmaster, and any switch acting as a boundary clock, to the SMPTE ST 2059-2 profile. The message names the setting out of range.'
}
