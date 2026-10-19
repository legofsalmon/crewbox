import type {
  NetmapDevice,
  NetmapDeviceState,
  NetmapLane,
  NetmapLaneId,
  NetmapPayload,
  NetmapReading,
  NetmapSource,
  NetmapWifi,
  NetmapWifiNetwork,
  ProcessorStatus,
} from '@crewbox/shared'
import type { ArtNode } from '../dmx/state.ts'
import type { MediaService } from '../netwatch/mdns.ts'
import type { SapStream } from '../netwatch/sap.ts'
import type { HeardHost } from './hosts.ts'
import type {
  Adapter,
  LldpNeighbour,
  Neighbour,
  Reading,
  WifiNetwork,
  WifiReading,
} from './system.ts'

/**
 * The network map, put together from what the box already holds.
 *
 * Pure: everything it needs is handed in, so the rules about who is shown
 * and how are tested without a socket or a file. Those rules are the point
 * of this file:
 *
 * - **A device is placed on the network the box heard it on**, joined by
 *   address across every source that saw it: an Art-Net node's reply, the
 *   sACN it sends, its entry in the box's neighbour table.
 * - **Phones and laptops are a count, never a list.** On the crew network,
 *   anything the box has exchanged traffic with that did not speak a show
 *   protocol is counted, as the privacy page promises of crew devices. The
 *   same goes for a show network that shares the crew adapter. Only the
 *   router is named there. Hosts heard only over plain mDNS are listed by
 *   address, never by the name their owner gave them.
 * - **Quiet is news, not a fault.** Each protocol has its own idea of how
 *   long a device may go unheard (QUIET_MS); past it, the device stays on the
 *   map marked quiet, with when it was last heard.
 * - **It is a lower bound,** and every lane's note says how it was built.
 */

/**
 * How long each source may go unheard before its device is called quiet.
 *
 * Reasoned, not measured: show data and clocks repeat every second or
 * faster, an Art-Net node answers each console poll (every few seconds), and
 * mDNS and SAP announcements repeat on the order of minutes.
 */
export const QUIET_MS: Partial<Record<NetmapSource, number>> = {
  artnet: 30_000,
  sacn: 30_000,
  ptp: 30_000,
  dante: 10 * 60_000,
  ndi: 10 * 60_000,
  nmos: 10 * 60_000,
  mdns: 10 * 60_000,
  sap: 10 * 60_000,
}

export interface DmxInput {
  heard: HeardHost[]
  nodes: ArtNode[]
  /** Every sACN or Art-Net source in the universe health, by its id. */
  sources: Array<{ id: string; name: string; protocol: 'artnet' | 'sacn'; lastSeen: number }>
  overflow: number
}

export interface MediaInput {
  heard: HeardHost[]
  services: MediaService[]
  streams: SapStream[]
  grandmaster: { id: string; lastAnnounce: number | null } | null
  overflow: number
}

export interface MapInput {
  now: number
  platform: string
  adapters: Adapter[]
  /**
   * The address each network is watched on: '' for whichever adapter the
   * system picks, undefined for a network this box is not watching.
   */
  watch: { crew: string; lighting?: string; media?: string; video?: string }
  gateway: { iface: string; gateway: string } | null
  neighbours: Reading<Neighbour[]>
  queriers: Reading<Map<string, string>>
  lldp: Reading<LldpNeighbour[]>
  wifi: Reading<WifiReading | null>
  crewSsid: string
  dmx?: DmxInput
  media?: MediaInput
  processors?: ProcessorStatus[]
}

const LABELS: Record<NetmapLaneId, string> = {
  crew: 'Crew',
  lighting: 'Lighting',
  media: 'Media',
  video: 'Video',
}

const STATE_ORDER: Record<NetmapDeviceState, number> = {
  silent: 0,
  quiet: 1,
  heard: 2,
  left: 3,
  listed: 4,
}

/** A device while it is being put together from several sources. */
interface Draft {
  key: string
  name: string
  address: string
  mac: string
  roles: Set<string>
  /** Source → when it was last heard from it (null: the source keeps no time). */
  seen: Map<NetmapSource, number | null>
  /** Every mDNS service on it said goodbye. */
  left: boolean
  /** The box asked and nothing answered. */
  silent: boolean
  /** A verdict a source made itself, which stands over the windows here. */
  state: NetmapDeviceState | null
}

class LaneDevices {
  private readonly byKey = new Map<string, Draft>()

  get(key: string, address = ''): Draft {
    let draft = this.byKey.get(key)
    if (!draft) {
      draft = {
        key,
        name: '',
        address,
        mac: '',
        roles: new Set(),
        seen: new Map(),
        left: false,
        silent: false,
        state: null,
      }
      this.byKey.set(key, draft)
    }
    return draft
  }

  has(key: string): boolean {
    return this.byKey.has(key)
  }

  finish(now: number): NetmapDevice[] {
    return [...this.byKey.values()]
      .map((d) => toDevice(d, now))
      .sort(
        (a, b) =>
          STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
          compareAddress(a.address, b.address) ||
          a.name.localeCompare(b.name)
      )
  }
}

function seen(draft: Draft, source: NetmapSource, at: number | null): void {
  const prior = draft.seen.get(source)
  draft.seen.set(source, prior == null || at == null ? (at ?? prior ?? null) : Math.max(prior, at))
}

function toDevice(d: Draft, now: number): NetmapDevice {
  const times = [...d.seen.values()].filter((t): t is number => t != null)
  const lastSeen = times.length > 0 ? Math.max(...times) : null
  // Heard if any timed source is inside its own window, or the only
  // evidence is a timeless one that is itself current (a neighbour entry).
  const timed = [...d.seen.entries()].filter(([, t]) => t != null) as Array<[NetmapSource, number]>
  const fresh = timed.some(([source, t]) => now - t < (QUIET_MS[source] ?? 60_000))
  const timeless = [...d.seen.values()].some((t) => t == null)
  let state: NetmapDeviceState
  if (d.state) state = d.state
  else if (fresh) state = 'heard'
  // An entry the box got no answer for, with nothing else current.
  else if (d.silent) state = 'silent'
  else if (d.left && timed.length > 0) state = 'left'
  else if (timed.length > 0) state = 'quiet'
  else state = timeless ? 'heard' : 'quiet'
  return {
    key: d.key,
    name: d.name,
    address: d.address,
    mac: d.mac,
    roles: [...d.roles],
    sources: [...d.seen.keys()].sort(),
    state,
    lastSeen,
  }
}

function compareAddress(a: string, b: string): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!
  return 0
}

/** The adapter a network is watched on, by its address; null for "any". */
function adapterFor(adapters: Adapter[], ip: string | undefined): Adapter | null {
  if (!ip) return null
  return adapters.find((a) => a.ipv4 === ip) ?? null
}

/** Whether a neighbour entry belongs to an adapter (by name, or by address on Windows). */
function onAdapter(n: Neighbour, adapter: Adapter | null): boolean {
  return Boolean(adapter) && (n.iface === adapter!.name || n.iface === adapter!.ipv4)
}

const MDNS_ROLE: Record<MediaService['kind'], string> = {
  dante: 'Dante device',
  ndi: 'NDI source',
  nmos: 'NMOS',
}

export function buildNetworkMap(input: MapInput): NetmapPayload {
  const { now, adapters, watch } = input
  const neighbours = input.neighbours.available ? input.neighbours.value : []

  // The crew adapter: the one the web server is bound to, or failing that
  // the one the default route leaves by, which is where phones reach it.
  const crewAdapter =
    adapterFor(adapters, watch.crew) ??
    adapters.find(
      (a) => input.gateway && (a.name === input.gateway.iface || a.ipv4 === input.gateway.iface)
    ) ??
    adapters[0] ??
    null
  const lanes: NetmapLane[] = []
  /** Addresses a show lane lists, so the crew count leaves them out. */
  const shown = new Set<string>()

  const lane = (id: NetmapLaneId, adapter: Adapter | null, watched: boolean): NetmapLane => {
    const lldp =
      adapter && input.lldp.available
        ? (input.lldp.value.find((n) => n.iface === adapter.name) ?? null)
        : null
    return {
      id,
      label: LABELS[id],
      adapter: adapter
        ? {
            name: adapter.name,
            ipv4: adapter.ipv4,
            cidr: adapter.cidr,
            mac: adapter.mac,
            speedMbps: adapter.speedMbps,
            up: adapter.up,
          }
        : null,
      watched,
      switchPort: lldp
        ? {
            system: lldp.system || lldp.chassis,
            port: lldp.port,
            description: lldp.portDescription,
          }
        : null,
      querier:
        adapter && input.queriers.available
          ? (input.queriers.value.get(adapter.name) ?? null)
          : null,
      devices: [],
      counted: 0,
      note: '',
    }
  }

  /** Neighbour entries on a show adapter: listed, unless that adapter is the crew's. */
  const addNeighbours = (devices: LaneDevices, adapter: Adapter | null) => {
    if (!adapter || adapter === crewAdapter) return
    for (const n of neighbours) {
      if (!onAdapter(n, adapter)) continue
      const d = devices.get(n.address, n.address)
      if (n.mac) d.mac = n.mac
      seen(d, 'neighbour', null)
      if (!n.answered) d.silent = true
    }
  }

  // -- lighting --------------------------------------------------------------
  if (input.dmx && watch.lighting !== undefined) {
    const adapter = adapterFor(adapters, watch.lighting)
    const l = lane('lighting', adapter, true)
    const devices = new LaneDevices()
    const byCid = new Map<string, string>()
    for (const host of input.dmx.heard) {
      const d = devices.get(host.address, host.address)
      for (const via of host.via)
        if (via === 'artnet' || via === 'sacn') seen(d, via, host.lastSeen)
      if (host.via.includes('sacn')) d.roles.add('sACN source')
      else if (host.via.includes('artnet')) d.roles.add('Art-Net sender')
      if (!d.name && host.names[0]) d.name = host.names[0]
      for (const id of host.ids) byCid.set(id, host.address)
    }
    for (const node of input.dmx.nodes) {
      const d = devices.get(node.ip, node.ip)
      d.name = node.name || node.longName || d.name
      d.roles.delete('Art-Net sender')
      d.roles.add('Art-Net node')
      seen(d, 'artnet', node.lastSeen)
    }
    // sACN sources heard before this box knew their address (or behind a
    // NAT): kept by CID, so a desk is never missing just for that.
    for (const source of input.dmx.sources) {
      if (source.protocol !== 'sacn') continue
      const address = byCid.get(source.id)
      const d = address ? devices.get(address, address) : devices.get(`cid:${source.id}`)
      if (source.name) d.name = source.name
      d.roles.add('sACN source')
      seen(d, 'sacn', source.lastSeen)
    }
    addNeighbours(devices, adapter)
    l.devices = devices.finish(now)
    l.note = sharedNote(adapter, crewAdapter, 'lighting')
    if (l.devices.length === 0)
      l.note ||=
        'Nothing heard yet. Consoles and nodes appear as they send Art-Net or sACN, or answer a console’s poll.'
    lanes.push(l)
  }

  // -- media -----------------------------------------------------------------
  if (input.media && watch.media !== undefined) {
    const adapter = adapterFor(adapters, watch.media)
    const l = lane('media', adapter, true)
    const devices = new LaneDevices()
    for (const service of input.media.services) {
      const source = service.kind as NetmapSource
      const d = service.address
        ? devices.get(service.address, service.address)
        : devices.get(`${service.kind}:${service.name}`)
      // One device often announces several services under one name; the
      // first gives it its name, the rest only its roles.
      if (!d.name) d.name = service.name
      d.roles.add(
        service.nmos
          ? `NMOS ${service.nmos.api === 'registration' ? 'registry' : service.nmos.api}`
          : MDNS_ROLE[service.kind]
      )
      const wasLeft = d.seen.size === 0 || d.left
      seen(d, source, service.lastSeen)
      d.left = wasLeft && service.saidGoodbye
    }
    for (const stream of input.media.streams) {
      if (!stream.origin) continue
      const d = devices.get(stream.origin, stream.origin)
      d.roles.add('Stream sender')
      seen(d, 'sap', stream.lastSeen)
    }
    for (const host of input.media.heard) {
      // A host heard only over plain mDNS, on a network that is also the
      // crew's, is someone's phone as often as not: counted, not listed.
      const plainOnly = host.via.every((v) => v === 'mdns')
      if (plainOnly && !devices.has(host.address) && adapter === crewAdapter && adapter) continue
      const d = devices.get(host.address, host.address)
      for (const via of host.via) {
        if (via === 'ptp') {
          d.roles.add('PTP clock')
          seen(d, 'ptp', host.lastSeen)
        } else if (via === 'sap') seen(d, 'sap', host.lastSeen)
        else if (via === 'mdns' && d.seen.size === 0) {
          d.roles.add('mDNS host')
          seen(d, 'mdns', host.lastSeen)
        }
      }
    }
    const gm = input.media.grandmaster
    if (gm) {
      const d = devices.get(`gm:${gm.id}`)
      d.name = gm.id
      d.roles.add('PTP grandmaster')
      seen(d, 'ptp', gm.lastAnnounce)
    }
    addNeighbours(devices, adapter)
    l.devices = devices.finish(now)
    l.note = sharedNote(adapter, crewAdapter, 'media')
    if (l.devices.length === 0)
      l.note ||=
        'Nothing heard yet. Dante, NDI and NMOS devices, clocks and streams appear as they announce themselves.'
    lanes.push(l)
  }

  // -- video -----------------------------------------------------------------
  if (input.processors && watch.video !== undefined) {
    const adapter = adapterFor(adapters, watch.video)
    const l = lane('video', adapter, true)
    const devices = new LaneDevices()
    for (const status of input.processors) {
      const p = status.processor
      const d = devices.get(p.host, p.host)
      d.name = p.name
      d.roles.add('LED processor')
      d.seen.set('processor', status.lastHeard)
      // The watcher already judged it, poll by poll: that verdict stands
      // rather than a window guessed here.
      d.state =
        status.state === 'listed' ? 'listed' : status.state === 'watching' ? 'heard' : 'silent'
    }
    l.devices = devices.finish(now)
    l.note =
      l.devices.length === 0
        ? 'No LED processors named yet. They are added in the Video pane, and the box contacts only those an admin arms.'
        : 'Only the processors someone named. The box reads the ones an admin armed and contacts nothing else.'
    lanes.push(l)
  }

  for (const l of lanes) for (const d of l.devices) if (d.address) shown.add(d.address)

  // -- crew ------------------------------------------------------------------
  {
    const l = lane('crew', crewAdapter, true)
    const devices = new LaneDevices()
    let counted = 0
    for (const n of neighbours) {
      if (!onAdapter(n, crewAdapter) || !n.answered) continue
      if (input.gateway && n.address === input.gateway.gateway) {
        const d = devices.get(n.address, n.address)
        d.name = 'Router'
        d.mac = n.mac
        d.roles.add('Gateway')
        seen(d, 'gateway', null)
        continue
      }
      if (shown.has(n.address)) continue
      counted++
    }
    // The route says where the gateway is even before the box has talked to it.
    if (
      input.gateway &&
      crewAdapter &&
      (input.gateway.iface === crewAdapter.name || input.gateway.iface === crewAdapter.ipv4)
    ) {
      const d = devices.get(input.gateway.gateway, input.gateway.gateway)
      d.name = 'Router'
      d.roles.add('Gateway')
      seen(d, 'gateway', null)
    }
    l.devices = devices.finish(now)
    l.counted = counted
    l.note = input.neighbours.available
      ? 'Phones and laptops are counted, never listed: only devices the box has exchanged traffic with show up here.'
      : `The box cannot read its neighbour table here (${input.neighbours.reason ?? 'not available'}), so this network shows only its router.`
    lanes.unshift(l)
  }

  const readings: NetmapReading[] = [
    reading('neighbours', input.neighbours),
    reading('querier', input.queriers),
    reading('lldp', input.lldp),
    reading('wifi', input.wifi),
  ]

  return {
    generatedAt: now,
    platform: input.platform,
    lanes,
    wifi: wifiOf(input),
    readings,
    overflow: (input.dmx?.overflow ?? 0) + (input.media?.overflow ?? 0),
  }
}

function sharedNote(adapter: Adapter | null, crew: Adapter | null, what: string): string {
  if (!adapter)
    return `Listening on whichever adapter the system picks, so the box's own tables can't be matched to the ${what} network.`
  if (adapter === crew)
    return `This network shares the crew adapter, so devices that don't speak a show protocol are counted with the crew, not listed.`
  return ''
}

function reading(what: NetmapReading['what'], r: Reading<unknown>): NetmapReading {
  return { what, available: r.available, reason: r.available ? '' : (r.reason ?? '') }
}

export function bandOf(freqMhz: number): NetmapWifiNetwork['band'] {
  if (freqMhz >= 2400 && freqMhz < 2500) return '2.4 GHz'
  if (freqMhz >= 5925 && freqMhz < 7200) return '6 GHz'
  if (freqMhz >= 5000 && freqMhz < 5925) return '5 GHz'
  return ''
}

/** At most this many networks are sent; a busy festival site hears hundreds. */
const MAX_WIFI = 60

function wifiOf(input: MapInput): NetmapWifi {
  const r = input.wifi
  const crewSsid = input.crewSsid
  if (!r.available || !r.value) {
    return {
      available: false,
      reason: r.reason ?? 'not read on this box',
      adapter: '',
      source: '',
      crewSsid,
      networks: [],
      channels: [],
    }
  }
  const { adapter, source, networks, survey } = r.value
  const shown: NetmapWifiNetwork[] = [...networks]
    .sort((a, b) => strength(b) - strength(a))
    .slice(0, MAX_WIFI)
    .map((n) => ({
      ssid: n.ssid,
      bssidTail: n.bssid.split(':').slice(3).join(':'),
      channel: n.channel,
      band: bandOf(n.freqMhz),
      signalDbm: n.signalDbm,
      signalPct: n.signalPct,
      security: n.security,
      stations: n.stations,
      utilisationPct: n.utilisationPct,
      crew: Boolean(crewSsid) && n.ssid === crewSsid,
      connected: n.connected,
    }))
  const channels = new Map<string, NetmapWifi['channels'][number]>()
  for (const n of networks) {
    if (!n.channel) continue
    const band = bandOf(n.freqMhz)
    const key = `${band} ${n.channel}`
    const c = channels.get(key) ?? {
      channel: n.channel,
      band,
      networks: 0,
      busyPct: null,
      noiseDbm: null,
    }
    c.networks++
    channels.set(key, c)
  }
  for (const s of survey) {
    const band = bandOf(s.freqMhz)
    const key = `${band} ${s.channel}`
    const c = channels.get(key)
    // A channel nobody is on is left out: the card is about congestion.
    if (!c) continue
    c.busyPct = s.busyPct
    c.noiseDbm = s.noiseDbm
  }
  return {
    available: true,
    reason: '',
    adapter,
    source,
    crewSsid,
    networks: shown,
    channels: [...channels.values()].sort(
      (a, b) => a.band.localeCompare(b.band) || a.channel - b.channel
    ),
  }
}

function strength(n: WifiNetwork): number {
  return n.signalDbm ?? n.signalPct / 2 - 100
}
