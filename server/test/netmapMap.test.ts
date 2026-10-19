import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NetmapPayload, ProcessorStatus } from '@crewbox/shared'
import { buildApp, type App } from '../src/app.ts'
import { openDb } from '../src/db.ts'
import { HeardHosts, MAX_HOSTS } from '../src/netmap/hosts.ts'
import { buildNetworkMap, type MapInput } from '../src/netmap/map.ts'
import { NetmapService } from '../src/netmap/service.ts'
import type { Adapter, SystemIo } from '../src/netmap/system.ts'
import { Store } from '../src/store.ts'

const NOW = 1_800_000_000_000

const adapter = (name: string, ipv4: string, prefix = 24): Adapter => ({
  name,
  ipv4,
  cidr: `${ipv4}/${prefix}`,
  mac: '',
  speedMbps: null,
  up: true,
  wireless: null,
})

const none = <T>(value: T) => ({ available: false, reason: 'not here', value })
const got = <T>(value: T) => ({ available: true, value })

function input(over: Partial<MapInput> = {}): MapInput {
  return {
    now: NOW,
    platform: 'linux',
    adapters: [adapter('wlan0', '10.0.0.2'), adapter('eth1', '2.0.0.10', 8)],
    watch: { crew: '10.0.0.2' },
    gateway: { iface: 'wlan0', gateway: '10.0.0.1' },
    neighbours: got([]),
    queriers: got(new Map()),
    lldp: got([]),
    wifi: none(null),
    crewSsid: 'CREW',
    ...over,
  }
}

const lane = (map: NetmapPayload, id: string) => map.lanes.find((l) => l.id === id)!

describe('the crew network', () => {
  it('names the router and counts everything else, never listing a phone', () => {
    const map = buildNetworkMap(
      input({
        neighbours: got([
          { address: '10.0.0.1', mac: 'aa:bb:cc:00:00:01', iface: 'wlan0', answered: true },
          { address: '10.0.0.40', mac: 'aa:bb:cc:00:00:40', iface: 'wlan0', answered: true },
          { address: '10.0.0.41', mac: 'aa:bb:cc:00:00:41', iface: 'wlan0', answered: true },
          { address: '10.0.0.42', mac: '', iface: 'wlan0', answered: false },
        ]),
      })
    )
    const crew = lane(map, 'crew')
    expect(crew.devices.map((d) => [d.name, d.address])).toEqual([['Router', '10.0.0.1']])
    expect(crew.counted).toBe(2)
    expect(JSON.stringify(map)).not.toContain('10.0.0.40')
    expect(JSON.stringify(map)).not.toContain('aa:bb:cc:00:00:41')
  })

  it('comes first, and alone when the box watches nothing else', () => {
    expect(buildNetworkMap(input()).lanes.map((l) => l.id)).toEqual(['crew'])
  })
})

describe('the lighting network', () => {
  const heard = new HeardHosts()
  heard.note('2.0.0.5', 'sacn', NOW - 1000, 'MA3 FOH', 'cid-desk')
  heard.note('2.0.0.31', 'artnet', NOW - 5 * 60_000)

  const map = buildNetworkMap(
    input({
      watch: { crew: '10.0.0.2', lighting: '2.0.0.10' },
      queriers: got(new Map([['eth1', 'V2']])),
      lldp: got([
        { iface: 'eth1', system: 'GC16-FOH', port: 'gi7', portDescription: '', chassis: '' },
      ]),
      neighbours: got([
        { address: '2.0.0.31', mac: '00:11:22:33:44:31', iface: 'eth1', answered: true },
        { address: '2.0.0.77', mac: '', iface: 'eth1', answered: false },
      ]),
      dmx: {
        heard: heard.list(),
        nodes: [
          {
            ip: '2.0.0.31',
            name: 'Node 31',
            longName: '',
            firstSeen: NOW - 600_000,
            lastSeen: NOW - 4 * 60_000,
          },
        ],
        sources: [
          { id: 'cid-desk', name: 'MA3 FOH', protocol: 'sacn', lastSeen: NOW - 1000 },
          { id: 'cid-backup', name: 'MA3 Backup', protocol: 'sacn', lastSeen: NOW - 2000 },
        ],
        overflow: 0,
      },
    })
  )
  const lighting = lane(map, 'lighting')

  it('joins a console’s sACN to the address it was heard from', () => {
    const desk = lighting.devices.find((d) => d.address === '2.0.0.5')!
    expect(desk).toMatchObject({ name: 'MA3 FOH', state: 'heard', roles: ['sACN source'] })
  })

  it('keeps a source it has no address for, by its name', () => {
    expect(lighting.devices.find((d) => d.name === 'MA3 Backup')).toMatchObject({
      address: '',
      state: 'heard',
    })
  })

  it('marks a node that stopped answering polls as quiet, with its MAC', () => {
    expect(lighting.devices.find((d) => d.address === '2.0.0.31')).toMatchObject({
      name: 'Node 31',
      mac: '00:11:22:33:44:31',
      roles: ['Art-Net node'],
      state: 'quiet',
      lastSeen: NOW - 4 * 60_000,
    })
  })

  it('lists a neighbour that never answered as silent, problems first', () => {
    expect(lighting.devices[0]).toMatchObject({ address: '2.0.0.77', state: 'silent' })
  })

  it('names its switch port and the querier', () => {
    expect(lighting.switchPort).toEqual({ system: 'GC16-FOH', port: 'gi7', description: '' })
    expect(lighting.querier).toBe('V2')
  })

  it('leaves lighting devices out of the crew count', () => {
    expect(lane(map, 'crew').counted).toBe(0)
  })
})

describe('a show network on the crew adapter', () => {
  it('lists the show devices and counts the rest with the crew', () => {
    const heard = new HeardHosts()
    heard.note('10.0.0.60', 'mdns', NOW)
    heard.note('10.0.0.61', 'ptp', NOW)
    const map = buildNetworkMap(
      input({
        watch: { crew: '10.0.0.2', media: '10.0.0.2' },
        neighbours: got([
          { address: '10.0.0.60', mac: '', iface: 'wlan0', answered: true },
          { address: '10.0.0.61', mac: '', iface: 'wlan0', answered: true },
        ]),
        media: {
          heard: heard.list(),
          services: [],
          streams: [],
          grandmaster: null,
          overflow: 0,
        },
      })
    )
    const media = lane(map, 'media')
    expect(media.devices.map((d) => d.address)).toEqual(['10.0.0.61'])
    expect(media.note).toMatch(/shares the crew adapter/)
    // The PTP clock is listed with the media network, so only the phone counts.
    expect(lane(map, 'crew').counted).toBe(1)
  })
})

describe('the media network', () => {
  it('groups a device’s services under its address and says when it left', () => {
    const map = buildNetworkMap(
      input({
        watch: { crew: '10.0.0.2', media: '' },
        media: {
          heard: [],
          services: [
            {
              name: 'Stagebox-1',
              kind: 'dante',
              address: '192.168.10.21',
              firstSeen: NOW - 60_000,
              lastSeen: NOW - 30_000,
              saidGoodbye: false,
            },
            {
              name: 'Old-Amp',
              kind: 'dante',
              address: '192.168.10.40',
              firstSeen: NOW - 3_600_000,
              lastSeen: NOW - 20 * 60_000,
              saidGoodbye: true,
            },
          ],
          streams: [
            {
              name: 'Stagebox mix',
              origin: '192.168.10.21',
              connection: '239.69.1.1',
              firstSeen: NOW - 60_000,
              lastSeen: NOW - 1000,
              sdp: null,
            },
          ],
          grandmaster: { id: '00-1d-c1-ff-fe-00-00-01', lastAnnounce: NOW - 500 },
          overflow: 0,
        },
      })
    )
    const media = lane(map, 'media')
    expect(media.adapter).toBeNull()
    expect(media.devices.find((d) => d.address === '192.168.10.21')).toMatchObject({
      name: 'Stagebox-1',
      roles: ['Dante device', 'Stream sender'],
      state: 'heard',
    })
    expect(media.devices.find((d) => d.address === '192.168.10.40')?.state).toBe('left')
    expect(media.devices.find((d) => d.roles.includes('PTP grandmaster'))?.state).toBe('heard')
  })
})

describe('the video network', () => {
  it('takes the watcher’s own verdict on each processor', () => {
    const status = (host: string, state: ProcessorStatus['state']): ProcessorStatus => ({
      processor: {
        id: host,
        name: `Wall ${host}`,
        host,
        monitored: state !== 'listed',
        addedBy: 'Sam',
        addedAt: NOW,
        source: 'manual',
      },
      state,
      health: 'ok',
      summary: '',
      reading: null,
      lastHeard: state === 'watching' ? NOW - 20_000 : null,
      misses: 0,
    })
    const map = buildNetworkMap(
      input({
        watch: { crew: '10.0.0.2', video: '' },
        processors: [
          status('192.168.0.10', 'watching'),
          status('192.168.0.11', 'unreachable'),
          status('192.168.0.12', 'listed'),
        ],
      })
    )
    expect(lane(map, 'video').devices.map((d) => [d.address, d.state])).toEqual([
      ['192.168.0.11', 'silent'],
      ['192.168.0.10', 'heard'],
      ['192.168.0.12', 'listed'],
    ])
  })
})

describe('Wi-Fi around the box', () => {
  it('marks the crew network, keeps only the BSSID’s tail, and adds channel busy time', () => {
    const map = buildNetworkMap(
      input({
        wifi: got({
          adapter: 'wlan0',
          source: 'iw' as const,
          networks: [
            {
              ssid: 'Venue-Guest',
              bssid: '66:77:88:99:9a:07',
              freqMhz: 2412,
              channel: 1,
              signalDbm: -52,
              signalPct: 96,
              security: 'open',
              stations: null,
              utilisationPct: null,
              connected: false,
              ageS: 2,
            },
            {
              ssid: 'CREW',
              bssid: '11:22:33:44:4e:21',
              freqMhz: 2412,
              channel: 1,
              signalDbm: -77,
              signalPct: 46,
              security: 'WPA2/3',
              stations: 9,
              utilisationPct: 74,
              connected: true,
              ageS: 2,
            },
          ],
          survey: [{ freqMhz: 2412, channel: 1, busyPct: 61, noiseDbm: -90, inUse: true }],
        }),
      })
    )
    expect(map.wifi.networks.map((n) => [n.ssid, n.crew, n.bssidTail])).toEqual([
      ['Venue-Guest', false, '99:9a:07'],
      ['CREW', true, '44:4e:21'],
    ])
    expect(map.wifi.channels).toEqual([
      { channel: 1, band: '2.4 GHz', networks: 2, busyPct: 61, noiseDbm: -90 },
    ])
  })

  it('says why when the box cannot read Wi-Fi', () => {
    expect(buildNetworkMap(input()).wifi).toMatchObject({ available: false, reason: 'not here' })
  })
})

describe('heard hosts', () => {
  it('refuses new addresses once full rather than evicting real ones', () => {
    const heard = new HeardHosts()
    for (let i = 0; i < MAX_HOSTS; i++) heard.note(`10.${i >> 8}.${i & 255}.1`, 'artnet', NOW)
    heard.note('192.168.1.1', 'artnet', NOW)
    expect(heard.list()).toHaveLength(MAX_HOSTS)
    expect(heard.overflow()).toBe(1)
  })

  it('ignores anything that is not an IPv4 address', () => {
    const heard = new HeardHosts()
    heard.note('::1', 'mdns', NOW)
    heard.note('0.0.0.0', 'mdns', NOW)
    expect(heard.list()).toEqual([])
  })
})

describe('/api/netmap', () => {
  let app: App | undefined
  let dir = ''
  afterEach(async () => {
    await app?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('is for any signed-in crew member, and reads only through the injected tables', async () => {
    dir = mkdtempSync(join(tmpdir(), 'crewbox-netmap-'))
    const db = openDb(':memory:')
    const store = new Store(db)
    store.createChannel('general', 'public', 'Everyone')
    const reads: string[] = []
    const io: SystemIo = {
      platform: 'linux',
      readFile: async (path) => {
        reads.push(path)
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      listDir: async () => [],
      run: async (cmd) => {
        reads.push(cmd)
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      interfaces: () => ({}),
    }
    app = buildApp({
      store,
      eventPin: '4242',
      filesDir: dir,
      dataDir: dir,
      adminPassword: 'netmap-admin-pass',
      modules: ['chat', 'network'],
      netmap: new NetmapService(io),
      logger: false,
    })
    expect((await app.inject({ method: 'GET', url: '/api/netmap' })).statusCode).toBe(401)
    const joined = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Alex', eventPin: '4242', personalPin: '1234' },
    })
    const { token } = joined.json() as { token: string }
    const res = await app.inject({
      method: 'GET',
      url: '/api/netmap',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const map = res.json() as NetmapPayload
    expect(map.lanes.map((l) => l.id)).toEqual(['crew'])
    expect(map.readings.find((r) => r.what === 'neighbours')?.available).toBe(false)
    expect(reads).toContain('/proc/net/arp')
  })
})
