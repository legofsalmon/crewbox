import type { NetmapPayload } from '@crewbox/shared'
import { buildNetworkMap, type MapInput } from './map.ts'
import {
  readAdapters,
  readGateway,
  readLldp,
  readNeighbours,
  readQueriers,
  readWifi,
  realSystemIo,
  type SystemIo,
} from './system.ts'

/**
 * The box's own readings, taken at most once per CACHE_MS however many panes
 * are open: each is a file read or a short command, cheap, but not something
 * to run once per viewer every ten seconds.
 */
const CACHE_MS = 5_000

type SystemReadings = Pick<
  MapInput,
  'adapters' | 'gateway' | 'neighbours' | 'queriers' | 'lldp' | 'wifi'
>

export class NetmapService {
  private cached: { at: number; readings: Promise<SystemReadings> } | null = null

  constructor(
    private readonly io: SystemIo = realSystemIo,
    private readonly clock: () => number = Date.now
  ) {}

  private readings(): Promise<SystemReadings> {
    const now = this.clock()
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.readings
    const io = this.io
    const readings = (async () => {
      const [adapters, gateway, neighbours, queriers, lldp, wifi] = await Promise.all([
        readAdapters(io),
        readGateway(io),
        readNeighbours(io),
        readQueriers(io),
        readLldp(io),
        readWifi(io),
      ])
      return { adapters, gateway: gateway.value, neighbours, queriers, lldp, wifi }
    })()
    this.cached = { at: now, readings }
    return readings
  }

  /** The map, from what the caller holds plus the box's own readings. */
  async build(
    held: Omit<MapInput, keyof SystemReadings | 'now' | 'platform'>
  ): Promise<NetmapPayload> {
    const readings = await this.readings()
    return buildNetworkMap({ ...held, ...readings, now: this.clock(), platform: this.io.platform })
  }
}
