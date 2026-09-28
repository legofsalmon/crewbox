import type { SdpCheck } from './sdp.ts'

/**
 * SAP (RFC 2974), overheard — the roster of AES67/RAVENNA and ST 2110 streams.
 *
 * Standards-based audio-over-IP announces its streams with Session
 * Announcement Protocol: an SDP description multicast to 239.255.255.255:9875,
 * repeated every few minutes for as long as the stream exists, with an
 * explicit deletion message when it ends. Listening — which is all this does —
 * yields the stream directory: what is being sent, by whom, from where. ST
 * 2110 senders that announce do it the same way, and since each announcement
 * is the stream's whole SDP file, the directory also checks every one
 * (netwatch/sdp.ts). It reads the announcements and nothing more: joining a
 * stream to look at it would pull gigabits of video onto whatever port the
 * box is on.
 *
 * Dante only speaks SAP for flows explicitly put in AES67 mode, so this
 * roster is the standards-world complement to the mDNS device roster, not a
 * replacement for it.
 */

export const SAP_PORT = 9875
export const SAP_GROUP = '239.255.255.255'

export interface SapMessage {
  /** True for a deletion announcement (the T flag). */
  deletion: boolean
  /** Hash + origin together identify the announcement across repeats. */
  id: string
  /** From SDP `s=` — the stream's human name. */
  sessionName: string
  /** From SDP `o=` — the announcing host, when it is an address. */
  origin: string
  /** From SDP `c=` — where the stream is sent (usually a multicast group). */
  connection: string
  /** The SDP file itself, or '' when it is longer than MAX_SDP_LENGTH. */
  sdp: string
}

/**
 * The longest SDP file the directory keeps. A real one is a kilobyte or two
 * and a SAP datagram is meant to stay under one; this bounds what 256
 * streams can hold, and a file past it is listed but not checked.
 */
export const MAX_SDP_LENGTH = 16 * 1024

/**
 * Parse one SAP datagram. Returns null for junk. Authenticated SAP (auth
 * length > 0) is skipped past rather than verified — nothing here acts on
 * the content, so the honest posture is "report what was announced".
 */
export function parseSap(buf: Buffer): SapMessage | null {
  if (buf.length < 8) return null
  const flags = buf[0]!
  // RFC 2974 §3: version in the top three bits, and this memo defines 1.
  if (flags >> 5 !== 1) return null
  const addressLength = (flags & 0x10) !== 0 ? 16 : 4 // A flag: IPv6 origin
  const deletion = (flags & 0x04) !== 0 // T flag
  if ((flags & 0x02) !== 0) return null // E: encrypted, opaque to a listener
  const compressed = (flags & 0x01) !== 0
  if (compressed) return null // zlib payloads are rare and not worth the dependency
  const authLength = buf[1]! * 4
  const hash = buf.readUInt16BE(2)

  let at = 4 + addressLength + authLength
  if (at >= buf.length) return null

  // Optional MIME type, present in almost all real traffic.
  let payloadType = 'application/sdp'
  if (buf[at] !== undefined && buf.subarray(at).indexOf(0) !== -1 && buf[at] !== 0x76 /* 'v' */) {
    const end = buf.subarray(at).indexOf(0)
    payloadType = buf.toString('utf8', at, at + end)
    at += end + 1
  }
  if (!payloadType.includes('sdp')) return null

  const sdp = buf.toString('utf8', at)
  const line = (prefix: string): string => {
    for (const l of sdp.split(/\r?\n/)) {
      if (l.startsWith(prefix)) return l.slice(prefix.length).trim()
    }
    return ''
  }
  const originParts = line('o=').split(/\s+/)
  return {
    deletion,
    id: `${hash}:${originParts[0] ?? ''}:${originParts[1] ?? ''}`,
    sessionName: line('s='),
    origin: originParts[5] ?? '',
    connection: line('c=').split(/\s+/)[2]?.split('/')[0] ?? '',
    sdp: sdp.length <= MAX_SDP_LENGTH ? sdp : '',
  }
}

export interface SapStream {
  name: string
  origin: string
  connection: string
  firstSeen: number
  lastSeen: number
  /**
   * What the ST 2110 checks make of its SDP file; null until they have run,
   * or when they cannot (see SapOptions.check) — "not checked", never "fine".
   */
  sdp: SdpCheck | null
}

export interface SapOptions {
  /**
   * Checks an announced SDP file, or answers null when the checks are not
   * available yet. Injected so the directory stays pure and its tests need
   * no WebAssembly; the listener passes the real one.
   */
  check?: (sdp: string) => SdpCheck | null
}

/** A stream as kept: the listed facts, the file, and its last check. */
interface Entry extends Omit<SapStream, 'sdp'> {
  text: string
  checked: { text: string; result: SdpCheck | null } | null
}

/** SAP repeats announcements every few minutes; RFC 2974's own no-timeout
 *  floor is an hour. Half that is generous to slow announcers and still
 *  ages out streams whose sender vanished without a deletion. */
export const SAP_TIMEOUT_MS = 30 * 60_000

/**
 * How many streams the directory will hold.
 *
 * Each entry lives for half an hour after its last announcement, and the
 * id comes off the wire — so one sender can mint unlimited streams that
 * each occupy the directory for thirty minutes, and every read sorts the
 * whole thing. A large AES67 estate is a few hundred streams; this is only
 * reached by something wrong.
 */
export const MAX_STREAMS = 256

/** The stream directory. Deletions remove; silence eventually ages out. */
export class SapState {
  private readonly streams = new Map<string, Entry>()
  /** Announcements refused because the directory was full. */
  private overflowed = 0
  private readonly check: SapOptions['check']

  constructor(options: SapOptions = {}) {
    this.check = options.check
  }

  apply(message: SapMessage, now: number): void {
    if (message.deletion) {
      // An explicit deletion is the protocol working, not a fault — the
      // stream is simply gone, so it leaves the directory.
      this.streams.delete(message.id)
      return
    }
    let stream = this.streams.get(message.id)
    if (!stream) {
      // Full: refuse the new one rather than push out a stream that is
      // really on the network. A flood must not be able to empty the list
      // of what is actually there, which is the list's whole job.
      if (this.streams.size >= MAX_STREAMS) {
        this.overflowed++
        return
      }
      stream = {
        name: message.sessionName || message.id,
        origin: message.origin,
        connection: message.connection,
        firstSeen: now,
        lastSeen: now,
        text: '',
        checked: null,
      }
      this.streams.set(message.id, stream)
    }
    if (message.sessionName) stream.name = message.sessionName
    if (message.origin) stream.origin = message.origin
    if (message.connection) stream.connection = message.connection
    // Kept as announced, and checked when somebody reads the directory
    // rather than here: a stream repeats its announcement every few minutes
    // unchanged, and checking on the packet path would redo the same work
    // for every repeat of every stream.
    stream.text = message.sdp
    stream.lastSeen = now
  }

  /**
   * An entry's check, redone only when its file has changed. A null from the
   * checker — not loaded yet — is not kept, so the next read tries again; a
   * checker that throws is a bug in it, recorded as unchecked for this
   * version of the file rather than retried on every read.
   */
  private checkOf(entry: Entry): SdpCheck | null {
    if (!this.check || !entry.text) return null
    if (entry.checked?.text === entry.text) return entry.checked.result
    let result: SdpCheck | null
    try {
      result = this.check(entry.text)
      if (result === null) return null
    } catch {
      result = null
    }
    entry.checked = { text: entry.text, result }
    return result
  }

  sweep(now: number): void {
    for (const [id, stream] of this.streams) {
      if (now - stream.lastSeen > SAP_TIMEOUT_MS) this.streams.delete(id)
    }
  }

  /** How many announcements the directory had no room for. */
  overflow(): number {
    return this.overflowed
  }

  roster(): SapStream[] {
    return [...this.streams.values()]
      .map((entry) => ({
        name: entry.name,
        origin: entry.origin,
        connection: entry.connection,
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen,
        sdp: this.checkOf(entry),
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen || a.name.localeCompare(b.name))
  }

  clear(): void {
    this.streams.clear()
    this.overflowed = 0
  }
}
