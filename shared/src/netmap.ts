/**
 * The network map: what the box can say is on each network it has a leg
 * on, from what it has overheard and from tables its operating system keeps.
 *
 * Served by GET /api/netmap and drawn by the Network module's map view. It
 * is a lower bound by construction: a device that never announces itself
 * and never talks to the box is not in it, and the view says so.
 * docs/NETWORK_MAP.md says where every field comes from and how sure it is.
 */

/** The networks a box can have a leg on, as the audit already names them. */
export type NetmapLaneId = 'crew' | 'lighting' | 'media' | 'video'

/**
 * Where a device stands.
 *
 * `heard` it spoke recently. `quiet` it was heard, and has not been for
 * longer than its protocol normally goes without (the news an inventory
 * exists to carry). `left` it said goodbye on purpose, which is not a fault.
 * `silent` the box tried to reach it and nothing answered: an incomplete
 * neighbour entry, or an LED processor the box is watching that has stopped
 * replying. `listed` it is known only because someone typed it in.
 */
export type NetmapDeviceState = 'heard' | 'quiet' | 'left' | 'silent' | 'listed'

/** How the box knows about a device, one word each, for the row. */
export type NetmapSource =
  | 'artnet'
  | 'sacn'
  | 'dante'
  | 'ndi'
  | 'nmos'
  | 'mdns'
  | 'ptp'
  | 'sap'
  | 'neighbour'
  | 'gateway'
  | 'processor'

export interface NetmapDevice {
  /** Stable within one payload: the address, or an id when there is none. */
  key: string
  /** The device's own name where it gave one, otherwise ''. */
  name: string
  /** IPv4, or '' when the box knows the device only by an id (an sACN CID). */
  address: string
  mac: string
  /** What it was heard as: an Art-Net node, a Dante device, a PTP clock. */
  roles: string[]
  sources: NetmapSource[]
  state: NetmapDeviceState
  /** When it was last heard, or null when the source keeps no time. */
  lastSeen: number | null
}

export interface NetmapLane {
  id: NetmapLaneId
  label: string
  /** The adapter the box uses for this network, or null when it uses whichever. */
  adapter: {
    name: string
    ipv4: string
    cidr: string
    mac: string
    speedMbps: number | null
    up: boolean | null
  } | null
  /** Whether this network is being watched at all on this box. */
  watched: boolean
  /** The switch and port this adapter is plugged into, from LLDP. */
  switchPort: { system: string; port: string; description: string } | null
  /**
   * The IGMP querier column for this adapter: 'V1' or 'V2' is a querier
   * heard in the last ~260 s, 'V3' is either an IGMPv3 querier or none, and
   * null is not read on this box.
   */
  querier: string | null
  devices: NetmapDevice[]
  /**
   * Hosts the box has exchanged traffic with on this network that it does
   * not list: on the crew network these are phones and laptops, which the
   * privacy page promises appear only as a count.
   */
  counted: number
  /** A sentence for the lane when it has nothing to show, or a caveat. */
  note: string
}

export interface NetmapWifiNetwork {
  ssid: string
  /** The last three octets only: enough to tell access points apart. */
  bssidTail: string
  channel: number
  band: '2.4 GHz' | '5 GHz' | '6 GHz' | ''
  signalDbm: number | null
  signalPct: number
  security: string
  stations: number | null
  utilisationPct: number | null
  /** The crew Wi-Fi, by the name the admin typed in at setup. */
  crew: boolean
  connected: boolean
}

export interface NetmapWifiChannel {
  channel: number
  band: NetmapWifiNetwork['band']
  networks: number
  /** How busy the box's radio found it, where the driver reports it. */
  busyPct: number | null
  noiseDbm: number | null
}

export interface NetmapWifi {
  available: boolean
  /** Why the box cannot read Wi-Fi, when it cannot. */
  reason: string
  adapter: string
  source: 'iw' | 'nmcli' | ''
  /** The crew Wi-Fi's name from setup, or '' when it was never entered. */
  crewSsid: string
  networks: NetmapWifiNetwork[]
  channels: NetmapWifiChannel[]
}

/** One of the box's own readings, and whether it could be taken here. */
export interface NetmapReading {
  what: 'neighbours' | 'querier' | 'lldp' | 'wifi'
  available: boolean
  reason: string
}

export interface NetmapPayload {
  generatedAt: number
  platform: string
  lanes: NetmapLane[]
  wifi: NetmapWifi
  readings: NetmapReading[]
  /** Addresses refused because a watcher's list was full: a flood, if ever non-zero. */
  overflow: number
}
