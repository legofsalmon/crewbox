import { describe, expect, it } from 'vitest'
import type { NetmapDevice, NetmapLane } from '@crewbox/shared'
import { laneSummary, missingReadings, querierWords, sinceWords, splitDevices } from './netmap.ts'

const device = (address: string, state: NetmapDevice['state']): NetmapDevice => ({
  key: address,
  name: '',
  address,
  mac: '',
  roles: [],
  sources: [],
  state,
  lastSeen: null,
})

const lane = (over: Partial<NetmapLane>): NetmapLane => ({
  id: 'lighting',
  label: 'Lighting',
  adapter: null,
  watched: true,
  switchPort: null,
  querier: null,
  devices: [],
  counted: 0,
  note: '',
  ...over,
})

describe('the map’s words', () => {
  it('sums a lane up, problems named', () => {
    expect(
      laneSummary(
        lane({ devices: [device('a', 'heard'), device('b', 'quiet'), device('c', 'silent')] })
      )
    ).toBe('3 devices · 1 gone quiet · 1 not answering')
    expect(laneSummary(lane({ id: 'crew', counted: 1 }))).toBe('1 other device, counted')
  })

  it('never folds a problem away', () => {
    const devices = [device('a', 'heard'), device('b', 'heard'), device('c', 'quiet')]
    expect(splitDevices(devices, 2)).toEqual({ shown: [devices[2], devices[0]], folded: 1 })
    expect(splitDevices(devices, 0)).toEqual({ shown: [devices[2]], folded: 2 })
  })

  it('treats only a v1 or v2 querier as evidence', () => {
    expect(querierWords('V2')).toBe('IGMP querier heard (v2)')
    expect(querierWords('V3')).toMatch(/No IGMPv2 querier/)
    expect(querierWords(null)).toBe('')
  })

  it('says how long a device has been quiet', () => {
    expect(sinceWords(1_000_000 - 30_000, 1_000_000)).toBe('30 s')
    expect(sinceWords(1_000_000 - 4 * 60_000, 1_000_000)).toBe('4 min')
    expect(sinceWords(null, 1_000_000)).toBe('')
  })

  it('lists the readings the box could not take, with why', () => {
    expect(
      missingReadings([
        { what: 'lldp', available: false, reason: 'networkctl is not installed on this box' },
        { what: 'neighbours', available: true, reason: '' },
      ])
    ).toEqual(['Switch port: networkctl is not installed on this box'])
  })
})
