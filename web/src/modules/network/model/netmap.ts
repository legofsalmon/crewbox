import type {
  NetmapDevice,
  NetmapDeviceState,
  NetmapLane,
  NetmapPayload,
  NetmapReading,
  NetmapWifiNetwork,
} from '@crewbox/shared'
import { apiUrl } from '../../../lib/server.ts'

/** The map, session-authed like the audit beside it. */
export async function fetchNetmap(token: string): Promise<NetmapPayload> {
  const res = await fetch(apiUrl('/api/netmap'), {
    headers: { authorization: `Bearer ${token}` },
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string } & NetmapPayload
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`)
  return data
}

/** A device's state in the crew's words. Every dot has one beside it. */
export const STATE_WORDS: Record<NetmapDeviceState, string> = {
  heard: 'Heard',
  quiet: 'Gone quiet',
  silent: 'Not answering',
  left: 'Signed off',
  listed: 'Not contacted',
}

/** "4 min" — how long since a device was last heard, for a quiet row. */
export function sinceWords(lastSeen: number | null, now: number): string {
  if (lastSeen == null) return ''
  const s = Math.max(0, Math.round((now - lastSeen) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`
}

/** What heads a row: the device's own name, or its address. */
export function deviceTitle(device: NetmapDevice): string {
  return device.name || device.address || 'Unnamed device'
}

/** The one line under a lane's title that says how it stands. */
export function laneSummary(lane: NetmapLane): string {
  const parts: string[] = []
  const n = lane.devices.length
  if (lane.id === 'crew') {
    if (lane.counted > 0)
      parts.push(`${lane.counted} other device${lane.counted === 1 ? '' : 's'}, counted`)
  } else parts.push(`${n} device${n === 1 ? '' : 's'}`)
  const quiet = lane.devices.filter((d) => d.state === 'quiet').length
  const silent = lane.devices.filter((d) => d.state === 'silent').length
  if (quiet > 0) parts.push(`${quiet} gone quiet`)
  if (silent > 0) parts.push(`${silent} not answering`)
  return parts.join(' · ')
}

/** Problems first, then the rest; past `limit`, the healthy ones fold away. */
export function splitDevices(
  devices: NetmapDevice[],
  limit: number
): { shown: NetmapDevice[]; folded: number } {
  const problems = devices.filter((d) => d.state === 'quiet' || d.state === 'silent')
  const rest = devices.filter((d) => d.state !== 'quiet' && d.state !== 'silent')
  const room = Math.max(0, limit - problems.length)
  return { shown: [...problems, ...rest.slice(0, room)], folded: Math.max(0, rest.length - room) }
}

/**
 * The querier column in words. Only v1 and v2 are evidence: "V3" is
 * either an IGMPv3 querier or none at all, and the box cannot tell which.
 */
export function querierWords(querier: string | null): string {
  if (querier === 'V2' || querier === 'V1') return `IGMP querier heard (${querier.toLowerCase()})`
  if (querier === 'V3') return 'No IGMPv2 querier heard (a v3 one would not show here)'
  return ''
}

/** How strong a network is where the box is, in a word. */
export function signalWord(network: NetmapWifiNetwork): string {
  const dbm = network.signalDbm ?? network.signalPct / 2 - 100
  if (dbm >= -60) return 'Strong'
  if (dbm >= -70) return 'Good'
  if (dbm >= -80) return 'Weak'
  return 'Very weak'
}

/** "−58 dBm" or "84%", whichever the box could read. */
export function signalText(network: NetmapWifiNetwork): string {
  return network.signalDbm != null ? `${network.signalDbm} dBm` : `${network.signalPct}%`
}

const READING_WORDS: Record<NetmapReading['what'], string> = {
  neighbours: 'Devices the box has talked to',
  querier: 'IGMP querier',
  lldp: 'Switch port',
  wifi: 'Wi-Fi around the box',
}

/** The box's own readings it could not take here, each with why. */
export function missingReadings(readings: NetmapReading[]): string[] {
  return readings
    .filter((r) => !r.available)
    .map((r) => `${READING_WORDS[r.what]}: ${r.reason || 'not read on this box'}`)
}
