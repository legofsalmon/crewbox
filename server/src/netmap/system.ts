import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

/**
 * What the operating system already knows about the box's networks, read
 * without sending a packet.
 *
 * Every reading here is a table the kernel or a system service keeps anyway:
 * the neighbour (ARP) table, the IGMP querier column, the LLDP neighbour a
 * switch announced, the Wi-Fi networks the system's own scans found. Reading
 * them needs no privilege on the platforms that have them, and puts nothing
 * on any wire. The research behind each one, with its sources and confidence,
 * is in docs/NETWORK_MAP.md.
 *
 * The commands run are a short fixed list, every one a read, and
 * server/test/netmapReadOnly.test.ts holds them to it: `arp` always with
 * `-n` (without it, macOS looks every address up in DNS), `nmcli` always
 * with `--rescan no` (without it, a list older than 30 s starts a scan),
 * and `iw` only ever `scan dump` and `survey dump`, never `scan` itself.
 *
 * Nothing here throws. A table a platform does not have, a tool that is not
 * installed, or a command that times out is an `available: false` with the
 * reason, which the map shows as such: "not read on this box" is a fact
 * about the box, not a fault on the network.
 */

export interface SystemIo {
  platform: NodeJS.Platform
  readFile: (path: string) => Promise<string>
  listDir: (path: string) => Promise<string[]>
  run: (cmd: string, args: string[]) => Promise<string>
  interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>
}

/** A command is given this long to answer before its reading is abandoned. */
const RUN_TIMEOUT_MS = 3000

export const realSystemIo: SystemIo = {
  platform: process.platform,
  readFile: (path) => readFile(path, 'utf8'),
  listDir: (path) => readdir(path),
  run: (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(
        cmd,
        args,
        { timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      )
    }),
  interfaces: () => networkInterfaces(),
}

export interface Reading<T> {
  available: boolean
  /** Why it could not be read, when it could not. */
  reason?: string
  value: T
}

const missing = <T>(value: T, reason: string): Reading<T> => ({ available: false, reason, value })
const got = <T>(value: T): Reading<T> => ({ available: true, value })

function why(err: unknown, tool: string): string {
  const code = (err as { code?: unknown })?.code
  if (code === 'ENOENT') return `${tool} is not installed on this box`
  if ((err as { killed?: boolean })?.killed) return `${tool} did not answer in time`
  return `${tool} could not be read`
}

// -- adapters ----------------------------------------------------------------

export interface Adapter {
  name: string
  ipv4: string
  /** CIDR form, such as 10.0.0.2/24. */
  cidr: string
  mac: string
  /** Link speed in Mb/s, where the platform reports it; null otherwise. */
  speedMbps: number | null
  /** Whether the link is up, where the platform reports it. */
  up: boolean | null
  wireless: boolean | null
}

const MAC_NONE = '00:00:00:00:00:00'

/** The box's IPv4 adapters, with whatever the platform says about each link. */
export async function readAdapters(io: SystemIo): Promise<Adapter[]> {
  const out: Adapter[] = []
  for (const [name, addrs] of Object.entries(io.interfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      out.push({
        name,
        ipv4: addr.address,
        cidr: addr.cidr ?? addr.address,
        mac: addr.mac === MAC_NONE ? '' : addr.mac,
        speedMbps: null,
        up: null,
        wireless: null,
      })
    }
  }
  if (io.platform !== 'linux') return out
  // /sys/class/net is readable by anyone; a file a driver doesn't provide
  // (speed on Wi-Fi, for one) is left unknown rather than guessed.
  await Promise.all(
    out.map(async (adapter) => {
      const base = `/sys/class/net/${adapter.name}`
      const speed = Number((await io.readFile(`${base}/speed`).catch(() => '')).trim())
      if (Number.isFinite(speed) && speed > 0) adapter.speedMbps = speed
      const state = (await io.readFile(`${base}/operstate`).catch(() => '')).trim()
      if (state) adapter.up = state === 'up'
      adapter.wireless = await io
        .listDir(`${base}/wireless`)
        .then(() => true)
        .catch(() => false)
    })
  )
  return out
}

/** The default route's gateway, from /proc/net/route on Linux. */
export function parseProcRoute(text: string): { iface: string; gateway: string } | null {
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 3) continue
    const [iface, destination, gateway] = cols
    if (destination !== '00000000' || !gateway || gateway === '00000000') continue
    // Little-endian hex: 0100000A is 10.0.0.1.
    const n = Number.parseInt(gateway, 16)
    if (!Number.isFinite(n)) continue
    const ip = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.')
    return { iface: iface!, gateway: ip }
  }
  return null
}

export async function readGateway(
  io: SystemIo
): Promise<Reading<{ iface: string; gateway: string } | null>> {
  if (io.platform !== 'linux') return missing(null, 'read on Linux boxes only')
  try {
    return got(parseProcRoute(await io.readFile('/proc/net/route')))
  } catch {
    return missing(null, 'the route table could not be read')
  }
}

// -- neighbours --------------------------------------------------------------

export interface Neighbour {
  address: string
  mac: string
  /** The adapter's name on Linux and macOS; on Windows, its address. */
  iface: string
  /** False when the box asked and nobody answered (an incomplete entry). */
  answered: boolean
}

/** /proc/net/arp: the kernel's IPv4 neighbour table. Flags 0x2 is complete. */
export function parseProcArp(text: string): Neighbour[] {
  const out: Neighbour[] = []
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 6) continue
    const [address, , flags, mac, , iface] = cols
    const complete = (Number.parseInt(flags!, 16) & 0x2) !== 0
    out.push({
      address: address!,
      mac: complete && mac !== MAC_NONE ? mac!.toLowerCase() : '',
      iface: iface!,
      answered: complete,
    })
  }
  return out
}

/** Pads macOS's shortened octets: 0:1b:c:2 becomes 00:1b:0c:02. */
function fullMac(mac: string): string {
  return mac
    .split(/[:-]/)
    .map((part) => part.padStart(2, '0'))
    .join(':')
    .toLowerCase()
}

/** `arp -an` on macOS: "? (10.0.0.1) at 0:1b:c:2:3:4 on en0 ifscope [ethernet]". */
export function parseArpMac(text: string): Neighbour[] {
  const out: Neighbour[] = []
  const line = /\((\d+\.\d+\.\d+\.\d+)\) at (\S+) on (\S+)/
  for (const row of text.split('\n')) {
    const m = line.exec(row)
    if (!m) continue
    const [, address, mac, iface] = m
    const answered = mac !== '(incomplete)'
    // Broadcast and multicast entries are the box's own bookkeeping, not hosts.
    if (address!.endsWith('.255') || mac === 'ff:ff:ff:ff:ff:ff') continue
    if (Number(address!.split('.')[0]) >= 224) continue
    out.push({ address: address!, mac: answered ? fullMac(mac!) : '', iface: iface!, answered })
  }
  return out
}

/**
 * `arp -a` on Windows, where it never resolves names. Sections start with
 * "Interface: 10.0.0.2 --- 0xb", and each row is "10.0.0.1  00-1b-..  dynamic".
 * Only dynamic rows are hosts; static ones are broadcast and multicast.
 */
export function parseArpWindows(text: string): Neighbour[] {
  const out: Neighbour[] = []
  let iface = ''
  for (const row of text.split('\n')) {
    const head = /Interface:\s+(\d+\.\d+\.\d+\.\d+)/.exec(row)
    if (head) {
      iface = head[1]!
      continue
    }
    const m = /^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f-]{17})\s+dynamic/i.exec(row)
    if (m) out.push({ address: m[1]!, mac: fullMac(m[2]!), iface, answered: true })
  }
  return out
}

export async function readNeighbours(io: SystemIo): Promise<Reading<Neighbour[]>> {
  try {
    if (io.platform === 'linux') return got(parseProcArp(await io.readFile('/proc/net/arp')))
    if (io.platform === 'darwin') return got(parseArpMac(await io.run('arp', ['-an'])))
    if (io.platform === 'win32') return got(parseArpWindows(await io.run('arp', ['-a'])))
    return missing([], 'not read on this platform')
  } catch (err) {
    return missing([], why(err, io.platform === 'linux' ? 'the neighbour table' : 'arp'))
  }
}

// -- IGMP querier ------------------------------------------------------------

/**
 * /proc/net/igmp's Querier column, by adapter name.
 *
 * "V1" or "V2" means a querier of that version was heard in the last
 * QRV × QI + QRI (about 260 s at the defaults); "V3" means none of those was,
 * which is either an IGMPv3 querier or none at all, and the file cannot say
 * which (net/ipv4/igmp.c). So only V1 and V2 are evidence.
 */
export function parseProcIgmp(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = /^\d+\s+(\S+)\s*:\s*\d+\s+(V[123])\s*$/.exec(line.trim())
    if (m) out.set(m[1]!, m[2]!)
  }
  return out
}

export async function readQueriers(io: SystemIo): Promise<Reading<Map<string, string>>> {
  if (io.platform !== 'linux') return missing(new Map(), 'read on Linux boxes only')
  try {
    return got(parseProcIgmp(await io.readFile('/proc/net/igmp')))
  } catch {
    return missing(new Map(), 'the IGMP table could not be read')
  }
}

// -- LLDP --------------------------------------------------------------------

export interface LldpNeighbour {
  iface: string
  /** The switch's own name, when it sends one. */
  system: string
  /** The port the box is plugged into, as the switch names it. */
  port: string
  portDescription: string
  chassis: string
}

/**
 * `networkctl lldp --json=short`: what systemd-networkd heard switches
 * announce on each link it manages. Parsed defensively, because the field
 * names are read from systemd's source rather than seen on a box.
 */
export function parseNetworkctlLldp(text: string): LldpNeighbour[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const links = (data as { Neighbors?: unknown })?.Neighbors
  if (!Array.isArray(links)) return []
  const out: LldpNeighbour[] = []
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  for (const link of links) {
    const iface = str((link as { InterfaceName?: unknown })?.InterfaceName)
    const neighbours = (link as { Neighbors?: unknown })?.Neighbors
    if (!Array.isArray(neighbours)) continue
    for (const n of neighbours as Array<Record<string, unknown>>) {
      out.push({
        iface,
        system: str(n.SystemName),
        port: str(n.PortID),
        portDescription: str(n.PortDescription),
        chassis: str(n.ChassisID),
      })
    }
  }
  return out
}

export async function readLldp(io: SystemIo): Promise<Reading<LldpNeighbour[]>> {
  if (io.platform !== 'linux') return missing([], 'read on Linux boxes only')
  try {
    return got(parseNetworkctlLldp(await io.run('networkctl', ['lldp', '--json=short'])))
  } catch (err) {
    return missing([], why(err, 'networkctl'))
  }
}

// -- Wi-Fi -------------------------------------------------------------------

export interface WifiNetwork {
  ssid: string
  bssid: string
  freqMhz: number
  channel: number
  /** dBm where the tool reports it; null when only a percentage is known. */
  signalDbm: number | null
  /** 0-100, as NetworkManager reports it, or derived from dBm. */
  signalPct: number
  security: string
  /** From the access point's BSS Load element, when it sends one. */
  stations: number | null
  /** The access point's own measure of how busy its channel is, 0-100. */
  utilisationPct: number | null
  /** The network the box's own radio is joined to. */
  connected: boolean
  /** Seconds since the system's scan last saw it, where known. */
  ageS: number | null
}

export interface ChannelSurvey {
  freqMhz: number
  channel: number
  /** Share of the measured time the radio found the channel busy. */
  busyPct: number
  noiseDbm: number | null
  inUse: boolean
}

export interface WifiReading {
  adapter: string
  source: 'iw' | 'nmcli'
  networks: WifiNetwork[]
  survey: ChannelSurvey[]
}

/** IEEE channel numbering for the 2.4, 5 and 6 GHz bands. */
export function channelOf(freqMhz: number): number {
  if (freqMhz === 2484) return 14
  if (freqMhz >= 2412 && freqMhz < 2484) return (freqMhz - 2407) / 5
  if (freqMhz >= 5955 && freqMhz <= 7115) return (freqMhz - 5950) / 5
  if (freqMhz >= 5000 && freqMhz < 5925) return (freqMhz - 5000) / 5
  return 0
}

/** dBm to the 0-100 scale NetworkManager uses: -100 is 0 and -50 is 100. */
function pctOf(dbm: number): number {
  return Math.max(0, Math.min(100, Math.round(2 * (dbm + 100))))
}

/**
 * `iw dev <wlan> scan dump`: the kernel's cached scan results, which any
 * user may read (nl80211 GET_SCAN carries no admin flag). It never starts a
 * scan; the cache is whatever the system's own scans last found.
 */
export function parseIwScanDump(text: string): WifiNetwork[] {
  const out: WifiNetwork[] = []
  let cur: WifiNetwork | null = null
  for (const raw of text.split('\n')) {
    const bss = /^BSS ([0-9a-f:]{17})(?:\(on \S+\))?(\s*--\s*associated)?/i.exec(raw)
    if (bss) {
      cur = {
        ssid: '',
        bssid: bss[1]!.toLowerCase(),
        freqMhz: 0,
        channel: 0,
        signalDbm: null,
        signalPct: 0,
        security: 'open',
        stations: null,
        utilisationPct: null,
        connected: Boolean(bss[2]),
        ageS: null,
      }
      out.push(cur)
      continue
    }
    if (!cur) continue
    const line = raw.trim()
    let m: RegExpExecArray | null
    if ((m = /^freq:\s*(\d+(?:\.\d+)?)/.exec(line))) {
      cur.freqMhz = Math.round(Number(m[1]))
      cur.channel = channelOf(cur.freqMhz)
    } else if ((m = /^signal:\s*(-?\d+(?:\.\d+)?)\s*dBm/.exec(line))) {
      cur.signalDbm = Math.round(Number(m[1]))
      cur.signalPct = pctOf(cur.signalDbm)
    } else if ((m = /^last seen:\s*(\d+)\s*ms ago/.exec(line))) {
      cur.ageS = Math.round(Number(m[1]) / 1000)
    } else if ((m = /^SSID:\s?(.*)$/.exec(line))) {
      cur.ssid = m[1]!
    } else if (/^RSN:/.test(line)) {
      cur.security = 'WPA2/3'
    } else if (/^WPA:/.test(line) && cur.security === 'open') {
      cur.security = 'WPA'
    } else if ((m = /^\*\s*station count:\s*(\d+)/.exec(line))) {
      cur.stations = Number(m[1])
    } else if ((m = /^\*\s*channel utili[sz]ation:\s*(\d+)\/255/.exec(line))) {
      cur.utilisationPct = Math.round((Number(m[1]) / 255) * 100)
    }
  }
  return out
}

/** `iw dev <wlan> survey dump`: how busy the radio found each channel. */
export function parseIwSurvey(text: string): ChannelSurvey[] {
  const out: ChannelSurvey[] = []
  let cur: {
    freq: number
    inUse: boolean
    noise: number | null
    active: number
    busy: number
  } | null = null
  const flush = () => {
    if (cur && cur.active > 0)
      out.push({
        freqMhz: cur.freq,
        channel: channelOf(cur.freq),
        busyPct: Math.min(100, Math.round((cur.busy / cur.active) * 100)),
        noiseDbm: cur.noise,
        inUse: cur.inUse,
      })
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    let m: RegExpExecArray | null
    if ((m = /^frequency:\s*(\d+)(?:\.\d+)?\s*MHz(.*)$/.exec(line))) {
      flush()
      cur = { freq: Number(m[1]), inUse: /in use/.test(m[2]!), noise: null, active: 0, busy: 0 }
    } else if (!cur) continue
    else if ((m = /^noise:\s*(-?\d+)\s*dBm/.exec(line))) cur.noise = Number(m[1])
    else if ((m = /^channel active time:\s*(\d+)\s*ms/.exec(line))) cur.active = Number(m[1])
    else if ((m = /^channel busy time:\s*(\d+)\s*ms/.exec(line))) cur.busy = Number(m[1])
  }
  flush()
  return out
}

/** Splits nmcli's terse output, where ':' inside a field is escaped as '\:'. */
function splitTerse(line: string): string[] {
  const fields: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '\\' && i + 1 < line.length) cur += line[++i]
    else if (c === ':') {
      fields.push(cur)
      cur = ''
    } else cur += c
  }
  fields.push(cur)
  return fields
}

export const NMCLI_FIELDS = 'IN-USE,BSSID,SSID,FREQ,SIGNAL,SECURITY'

/**
 * `nmcli -t -f IN-USE,BSSID,SSID,FREQ,SIGNAL,SECURITY dev wifi list --rescan no`:
 * NetworkManager's cached list, which anyone may read over D-Bus. Signal is
 * NetworkManager's percentage; it gives no dBm and no load.
 */
export function parseNmcliWifi(text: string): WifiNetwork[] {
  const out: WifiNetwork[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const [inUse, bssid, ssid, freq, signal, security] = splitTerse(line)
    if (!bssid || !/^[0-9a-f:]{17}$/i.test(bssid)) continue
    const freqMhz = Number.parseInt(freq ?? '', 10) || 0
    out.push({
      ssid: ssid ?? '',
      bssid: bssid.toLowerCase(),
      freqMhz,
      channel: channelOf(freqMhz),
      signalDbm: null,
      signalPct: Math.max(0, Math.min(100, Number(signal) || 0)),
      security: security && security !== '--' ? security : 'open',
      stations: null,
      utilisationPct: null,
      connected: inUse === '*',
      ageS: null,
    })
  }
  return out
}

/** The box's wireless adapters, from /sys/class/net/<name>/wireless. */
async function wirelessAdapters(io: SystemIo): Promise<string[]> {
  const names = await io.listDir('/sys/class/net').catch(() => [] as string[])
  const out: string[] = []
  for (const name of names) {
    if (
      await io.listDir(`/sys/class/net/${name}/wireless`).then(
        () => true,
        () => false
      )
    )
      out.push(name)
  }
  return out.sort()
}

/**
 * The Wi-Fi around the box, from the system's own cached scans.
 *
 * Linux only. On a Mac the network names need Location Services granted to
 * the menu-bar app, and on Windows 11 24H2 every list call fails without
 * location consent (docs/NETWORK_MAP.md), so neither is read yet. `iw` is
 * preferred because it gives dBm, each access point's load figure and the
 * channel survey; NetworkManager's list is the fallback.
 */
export async function readWifi(io: SystemIo): Promise<Reading<WifiReading | null>> {
  if (io.platform === 'darwin')
    return missing(null, 'a Mac box needs Location Services to read Wi-Fi names, not set up yet')
  if (io.platform === 'win32')
    return missing(null, 'a Windows box needs location access to read Wi-Fi, not set up yet')
  if (io.platform !== 'linux') return missing(null, 'not read on this platform')
  const radios = await wirelessAdapters(io)
  if (radios.length === 0) return missing(null, 'this box has no Wi-Fi adapter')
  const adapter = radios[0]!
  let iwError: unknown = null
  try {
    const networks = parseIwScanDump(await io.run('iw', ['dev', adapter, 'scan', 'dump']))
    const survey = parseIwSurvey(
      await io.run('iw', ['dev', adapter, 'survey', 'dump']).catch(() => '')
    )
    return got({ adapter, source: 'iw', networks, survey })
  } catch (err) {
    iwError = err
  }
  try {
    const text = await io.run('nmcli', [
      '-t',
      '-f',
      NMCLI_FIELDS,
      'dev',
      'wifi',
      'list',
      'ifname',
      adapter,
      '--rescan',
      'no',
    ])
    return got({ adapter, source: 'nmcli', networks: parseNmcliWifi(text), survey: [] })
  } catch (err) {
    const iwMissing = (iwError as { code?: unknown })?.code === 'ENOENT'
    const nmMissing = (err as { code?: unknown })?.code === 'ENOENT'
    return missing(
      null,
      iwMissing && nmMissing
        ? 'neither iw nor NetworkManager is installed on this box'
        : why(iwMissing ? err : iwError, iwMissing ? 'nmcli' : 'iw')
    )
  }
}
