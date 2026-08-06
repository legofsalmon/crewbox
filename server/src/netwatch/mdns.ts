/**
 * mDNS, overheard — the roster of who is on the media network.
 *
 * Dante devices and NDI sources announce themselves over multicast DNS
 * (224.0.0.251:5353) as DNS-SD services. Announcements are multicast to the
 * whole group, so listening — which is all this does — sees every device
 * that speaks, with no query ever sent. What falls out is the roster an
 * audio tech actually wants: which devices are here, when each was last
 * heard, and who said goodbye (mDNS goodbyes are a real message: a record
 * republished with TTL 0).
 *
 * The parser is a deliberately small subset of DNS: enough to walk a
 * message's records and decode names (including compression pointers, which
 * every real mDNS packet uses). Anything malformed returns what was parsed
 * before the damage, never throws — junk on 5353 is a certainty, not a
 * possibility.
 *
 * Caveat carried to the panel: Dante Domain Manager deployments can move
 * discovery off mDNS, so an empty Dante roster on a DDM site is expected,
 * not evidence of absence.
 */

export const MDNS_PORT = 5353
export const MDNS_GROUP = '224.0.0.251'

const TYPE_A = 1
const TYPE_PTR = 12
const TYPE_SRV = 33

export interface MdnsRecord {
  name: string
  type: number
  ttl: number
  /** PTR: the target name. SRV: the host. A: the address. Otherwise ''. */
  value: string
}

/**
 * Decode a possibly-compressed DNS name starting at `offset`.
 * Returns the name (lowercased — DNS is case-insensitive and mDNS devices
 * disagree about it) and the offset after the name's in-place bytes.
 */
function readName(buf: Buffer, offset: number): { name: string; next: number } | null {
  const labels: string[] = []
  let at = offset
  let next = -1
  let hops = 0
  // A DNS name is at most 255 octets (RFC 1035 §3.1). Enforcing it bounds the
  // work per datagram: the hop guard alone still lets each of 16 pointer
  // follows read a long label run out of the buffer, so a small junk packet
  // could otherwise inflate into a large decoded string. Tallying the octets
  // and bailing at the spec limit removes that amplification entirely.
  let octets = 0
  while (true) {
    if (at >= buf.length) return null
    const len = buf[at]!
    if (len === 0) {
      if (next === -1) next = at + 1
      break
    }
    if ((len & 0xc0) === 0xc0) {
      // Compression pointer. The first one fixes where the record continues;
      // the hop guard stops a malicious or mangled pointer loop.
      if (at + 1 >= buf.length) return null
      if (next === -1) next = at + 2
      at = ((len & 0x3f) << 8) | buf[at + 1]!
      if (++hops > 16) return null
      continue
    }
    if ((len & 0xc0) !== 0) return null
    if (at + 1 + len > buf.length) return null
    octets += len + 1
    if (octets > 255) return null
    labels.push(buf.toString('utf8', at + 1, at + 1 + len))
    at += 1 + len
  }
  return { name: labels.join('.').toLowerCase(), next }
}

/** Every resource record in one mDNS message. Questions are skipped — a
 *  passive listener learns from answers, not from what others are asking. */
export function parseMdns(buf: Buffer): MdnsRecord[] {
  if (buf.length < 12) return []
  const questions = buf.readUInt16BE(4)
  const records = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10) // AN + NS + AR

  const out: MdnsRecord[] = []
  let at = 12

  for (let i = 0; i < questions; i++) {
    const q = readName(buf, at)
    if (!q) return out
    at = q.next + 4 // QTYPE + QCLASS
  }

  for (let i = 0; i < records && at < buf.length; i++) {
    const n = readName(buf, at)
    if (!n) return out
    at = n.next
    if (at + 10 > buf.length) return out
    const type = buf.readUInt16BE(at)
    const ttl = buf.readUInt32BE(at + 4)
    const rdlength = buf.readUInt16BE(at + 8)
    const rdata = at + 10
    if (rdata + rdlength > buf.length) return out

    let value = ''
    if (type === TYPE_PTR) {
      value = readName(buf, rdata)?.name ?? ''
    } else if (type === TYPE_SRV && rdlength >= 7) {
      value = readName(buf, rdata + 6)?.name ?? ''
    } else if (type === TYPE_A && rdlength === 4) {
      value = [...buf.subarray(rdata, rdata + 4)].join('.')
    }
    out.push({ name: n.name, type, ttl, value })
    at = rdata + rdlength
  }
  return out
}

export type MediaServiceKind = 'dante' | 'ndi'

/** Which roster a DNS-SD service type belongs to, or null to ignore it. */
export function serviceKind(serviceName: string): MediaServiceKind | null {
  // Dante advertises several services per device (_netaudio-arc, -dbc,
  // -cmc, -chan); any of them proves the device. NDI is one.
  if (/(^|\.)_netaudio-[a-z]+\._udp\.local$/.test(serviceName)) return 'dante'
  if (/(^|\.)_ndi\._tcp\.local$/.test(serviceName)) return 'ndi'
  return null
}

export interface MediaService {
  /** The instance label as advertised — the device or source name. */
  name: string
  kind: MediaServiceKind
  /** Host address, when an A record travelled in the same announcement. */
  address: string
  firstSeen: number
  lastSeen: number
  /** The device unregistered on purpose (TTL-0 goodbye) — not a timeout. */
  saidGoodbye: boolean
}

/**
 * The roster. Devices are never dropped — like the Art-Net node inventory,
 * a device that stopped announcing is the news, and `lastSeen` carries it.
 */
export class MdnsState {
  /** kind + instance name → record. */
  private readonly services = new Map<string, MediaService & { host: string }>()

  applyPacket(records: MdnsRecord[], now: number): void {
    // A-record addresses from this packet, to enrich instances announced
    // alongside them (mDNS announcements bundle PTR/SRV/TXT/A together).
    const addresses = new Map<string, string>()
    for (const record of records) {
      if (record.type === TYPE_A && record.value) addresses.set(record.name, record.value)
    }

    for (const record of records) {
      if (record.type === TYPE_PTR) {
        const kind = serviceKind(record.name)
        if (!kind || !record.value) continue
        this.notePtr(kind, record.value, record.ttl, now)
      } else if (record.type === TYPE_SRV) {
        const kind = serviceKind(record.name.replace(/^[^.]+\./, ''))
        if (!kind) continue
        const key = `${kind}:${record.name}`
        const service = this.services.get(key)
        if (service && record.value) {
          service.host = record.value
          const address = addresses.get(record.value)
          if (address) service.address = address
        }
      }
    }

    // Second pass: A records may name a host learned from an earlier packet.
    for (const service of this.services.values()) {
      if (!service.address && service.host) {
        const address = addresses.get(service.host)
        if (address) service.address = address
      }
    }
  }

  private notePtr(kind: MediaServiceKind, instance: string, ttl: number, now: number): void {
    const key = `${kind}:${instance}`
    let service = this.services.get(key)
    if (!service) {
      service = {
        name: instance.replace(/\._(netaudio-[a-z]+\._udp|ndi\._tcp)\.local$/, ''),
        kind,
        address: '',
        host: '',
        firstSeen: now,
        lastSeen: now,
        saidGoodbye: false,
      }
      this.services.set(key, service)
    }
    service.lastSeen = now
    // TTL 0 is the DNS-SD goodbye; anything else is a (re)announcement,
    // which also un-says an earlier goodbye — devices reboot.
    service.saidGoodbye = ttl === 0
  }

  /** The roster, most recently heard first. */
  roster(): MediaService[] {
    return [...this.services.values()]
      .map(({ host: _host, ...service }) => service)
      .sort((a, b) => b.lastSeen - a.lastSeen || a.name.localeCompare(b.name))
  }

  clear(): void {
    this.services.clear()
  }
}
