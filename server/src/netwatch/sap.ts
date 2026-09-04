/**
 * SAP (RFC 2974), overheard — the roster of AES67/RAVENNA streams.
 *
 * Standards-based audio-over-IP announces its streams with Session
 * Announcement Protocol: an SDP description multicast to 239.255.255.255:9875,
 * repeated every few minutes for as long as the stream exists, with an
 * explicit deletion message when it ends. Listening — which is all this does —
 * yields the stream directory: what is being sent, by whom, from where.
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
}

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
  }
}

export interface SapStream {
  name: string
  origin: string
  connection: string
  firstSeen: number
  lastSeen: number
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
  private readonly streams = new Map<string, SapStream>()
  /** Announcements refused because the directory was full. */
  private overflowed = 0

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
      }
      this.streams.set(message.id, stream)
    }
    if (message.sessionName) stream.name = message.sessionName
    if (message.origin) stream.origin = message.origin
    if (message.connection) stream.connection = message.connection
    stream.lastSeen = now
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
    return [...this.streams.values()].sort(
      (a, b) => b.lastSeen - a.lastSeen || a.name.localeCompare(b.name)
    )
  }

  clear(): void {
    this.streams.clear()
    this.overflowed = 0
  }
}
