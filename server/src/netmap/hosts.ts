/**
 * Who the watchers have heard, by address.
 *
 * The lighting listener and the media watcher already overhear every packet
 * they parse, and until the network map they threw the sender's address away
 * once the packet was decoded: a Dante device had an address only if an A
 * record happened to travel with its announcement, and an sACN console was
 * known only by its CID. This keeps the one fact each packet carries for
 * free, who sent it, so the map can place a device on its network.
 *
 * It is fed from the listeners' existing message handlers, so it opens no
 * socket and sends nothing. Like the mDNS roster it is bounded, because the
 * address comes off the wire: a flood of spoofed senders is refused rather
 * than allowed to push real devices out (see MAX_HOSTS).
 */

/** The protocol a sender was heard on. */
export type HeardVia = 'artnet' | 'sacn' | 'mdns' | 'ptp' | 'sap'

export interface HeardHost {
  address: string
  firstSeen: number
  lastSeen: number
  /** Every protocol this address has been heard speaking, sorted. */
  via: HeardVia[]
  /**
   * Names it gave itself: its mDNS host name, or the source name an sACN
   * console puts in every packet. At most a few.
   */
  names: string[]
  /** Identities it sent under, such as an sACN CID, so the map can join them up. */
  ids: string[]
}

/**
 * Well past any real rig's count of devices that talk on a show network. A
 * large festival's lighting and media estate is a few hundred senders, so
 * this is only reached by something wrong, and then new addresses are
 * refused rather than old ones evicted: the list's job is what is really on
 * the network, and a flood must not be able to empty it.
 */
export const MAX_HOSTS = 1024
const MAX_NAMES = 4

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/

interface Entry {
  address: string
  firstSeen: number
  lastSeen: number
  via: Set<HeardVia>
  names: Set<string>
  ids: Set<string>
}

export class HeardHosts {
  private readonly hosts = new Map<string, Entry>()
  private refused = 0

  note(address: string, via: HeardVia, now: number, name?: string, id?: string): void {
    if (!IPV4.test(address) || address === '0.0.0.0') return
    let entry = this.hosts.get(address)
    if (!entry) {
      if (this.hosts.size >= MAX_HOSTS) {
        this.refused++
        return
      }
      entry = {
        address,
        firstSeen: now,
        lastSeen: now,
        via: new Set(),
        names: new Set(),
        ids: new Set(),
      }
      this.hosts.set(address, entry)
    }
    entry.lastSeen = Math.max(entry.lastSeen, now)
    entry.via.add(via)
    if (name && entry.names.size < MAX_NAMES) entry.names.add(name)
    if (id && entry.ids.size < MAX_NAMES) entry.ids.add(id)
  }

  /** How many new addresses were refused because the list was full. */
  overflow(): number {
    return this.refused
  }

  list(): HeardHost[] {
    return [...this.hosts.values()]
      .map((entry) => ({
        address: entry.address,
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen,
        via: [...entry.via].sort(),
        names: [...entry.names],
        ids: [...entry.ids],
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen || a.address.localeCompare(b.address))
  }

  clear(): void {
    this.hosts.clear()
    this.refused = 0
  }
}
