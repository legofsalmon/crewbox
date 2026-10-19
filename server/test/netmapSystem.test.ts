import { describe, expect, it } from 'vitest'
import {
  channelOf,
  parseArpMac,
  parseArpWindows,
  parseIwScanDump,
  parseIwSurvey,
  parseNetworkctlLldp,
  parseNmcliWifi,
  parseProcArp,
  parseProcIgmp,
  parseProcRoute,
  parseNetstatMac,
  parseRouteWindows,
  readNeighbours,
  readWifi,
  type SystemIo,
} from '../src/netmap/system.ts'

/**
 * The box's own tables, parsed. Every sample is the shape the tool or file
 * prints, with made-up addresses; where a format was read from source rather
 * than seen on a box, docs/NETWORK_MAP.md says so.
 */

describe('the Linux tables', () => {
  it('reads the neighbour table, keeping an unanswered entry as such', () => {
    const text = [
      'IP address       HW type     Flags       HW address            Mask     Device',
      '10.0.0.1         0x1         0x2         AA:BB:CC:00:00:01     *        wlan0',
      '2.0.0.31         0x1         0x0         00:00:00:00:00:00     *        eth1',
      '',
    ].join('\n')
    expect(parseProcArp(text)).toEqual([
      { address: '10.0.0.1', mac: 'aa:bb:cc:00:00:01', iface: 'wlan0', answered: true },
      { address: '2.0.0.31', mac: '', iface: 'eth1', answered: false },
    ])
  })

  it('reads the default gateway from the route table, little-endian', () => {
    const text = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'eth1\t00000002\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0',
      'wlan0\t00000000\t0100000A\t0003\t0\t0\t600\t00000000\t0\t0\t0',
    ].join('\n')
    expect(parseProcRoute(text)).toEqual({ iface: 'wlan0', gateway: '10.0.0.1' })
    expect(parseProcRoute(text.split('\n').slice(0, 2).join('\n'))).toBeNull()
  })

  it('reads the querier column per adapter', () => {
    const text = [
      'Idx\tDevice    : Count Querier\tGroup    Users Timer\tReporter',
      '1\tlo        :     1      V3',
      '\t\t\t\t010000E0     1 0:00000000\t\t0',
      '2\teth1      :     3      V2',
      '\t\t\t\t010000E0     1 0:00000000\t\t0',
      '3\twlan0     :     2      V3',
    ].join('\n')
    const q = parseProcIgmp(text)
    expect(q.get('eth1')).toBe('V2')
    expect(q.get('wlan0')).toBe('V3')
  })

  it('reads the switch and port networkd heard over LLDP', () => {
    const json = JSON.stringify({
      Neighbors: [
        {
          InterfaceIndex: 3,
          InterfaceName: 'eth1',
          Neighbors: [
            {
              ChassisID: '00:11:22:33:44:55',
              PortID: 'gi7',
              PortDescription: 'GigaCore port 7',
              SystemName: 'GC16-FOH',
            },
          ],
        },
      ],
    })
    expect(parseNetworkctlLldp(json)).toEqual([
      {
        iface: 'eth1',
        system: 'GC16-FOH',
        port: 'gi7',
        portDescription: 'GigaCore port 7',
        chassis: '00:11:22:33:44:55',
      },
    ])
    expect(parseNetworkctlLldp('not json')).toEqual([])
    expect(parseNetworkctlLldp('{"Neighbors":7}')).toEqual([])
  })
})

describe('the macOS and Windows tables', () => {
  it('reads the default route on a Mac and on Windows', () => {
    const mac = [
      'Routing tables',
      '',
      'Internet:',
      'Destination        Gateway            Flags               Netif Expire',
      'default            10.0.0.1           UGScg                 en0       ',
      '10.0.0/24          link#6             UCS                   en0      !',
    ].join('\n')
    expect(parseNetstatMac(mac)).toEqual({ gateway: '10.0.0.1', iface: 'en0' })
    const win = [
      'IPv4 Route Table',
      'Network Destination        Netmask          Gateway       Interface  Metric',
      '          0.0.0.0          0.0.0.0         10.0.0.1        10.0.0.2     25',
    ].join('\r\n')
    expect(parseRouteWindows(win)).toEqual({ gateway: '10.0.0.1', iface: '10.0.0.2' })
  })

  it('reads arp -an on a Mac, padding short octets and skipping broadcast', () => {
    const text = [
      '? (10.0.0.1) at 0:1b:c:2:3:4 on en0 ifscope [ethernet]',
      '? (10.0.0.9) at (incomplete) on en0 ifscope [ethernet]',
      '? (10.0.0.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]',
      '? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]',
    ].join('\n')
    expect(parseArpMac(text)).toEqual([
      { address: '10.0.0.1', mac: '00:1b:0c:02:03:04', iface: 'en0', answered: true },
      { address: '10.0.0.9', mac: '', iface: 'en0', answered: false },
    ])
  })

  it('reads arp -a on Windows, keeping dynamic rows only', () => {
    const text = [
      '',
      'Interface: 10.0.0.2 --- 0xb',
      '  Internet Address      Physical Address      Type',
      '  10.0.0.1              aa-bb-cc-00-00-01     dynamic',
      '  10.0.0.255            ff-ff-ff-ff-ff-ff     static',
    ].join('\r\n')
    expect(parseArpWindows(text)).toEqual([
      { address: '10.0.0.1', mac: 'aa:bb:cc:00:00:01', iface: '10.0.0.2', answered: true },
    ])
  })
})

describe('Wi-Fi from cached scans', () => {
  const dump = [
    'BSS 11:22:33:44:4e:21(on wlan0) -- associated',
    '\tTSF: 1 usec (0d, 00:00:00)',
    '\tfreq: 5180',
    '\tbeacon interval: 100 TUs',
    '\tsignal: -58.00 dBm',
    '\tlast seen: 1200 ms ago',
    '\tSSID: CREW',
    '\tRSN:\t * Version: 1',
    '\tBSS Load:',
    '\t\t * station count: 12',
    '\t\t * channel utilisation: 79/255',
    'BSS 66:77:88:99:9a:07(on wlan0)',
    '\tfreq: 2412.0',
    '\tsignal: -77.00 dBm',
    '\tSSID: Venue-Guest',
  ].join('\n')

  it('reads iw scan dump: signal, channel, security and each access point’s load', () => {
    const [crew, guest] = parseIwScanDump(dump)
    expect(crew).toMatchObject({
      ssid: 'CREW',
      bssid: '11:22:33:44:4e:21',
      freqMhz: 5180,
      channel: 36,
      signalDbm: -58,
      signalPct: 84,
      security: 'WPA2/3',
      stations: 12,
      utilisationPct: 31,
      connected: true,
      ageS: 1,
    })
    expect(guest).toMatchObject({
      ssid: 'Venue-Guest',
      channel: 1,
      security: 'open',
      stations: null,
    })
  })

  it('reads iw survey dump into busy time per channel', () => {
    const text = [
      'Survey data from wlan0',
      '\tfrequency:\t\t\t5180 MHz [in use]',
      '\tnoise:\t\t\t\t-92 dBm',
      '\tchannel active time:\t\t1000 ms',
      '\tchannel busy time:\t\t420 ms',
      'Survey data from wlan0',
      '\tfrequency:\t\t\t5200 MHz',
    ].join('\n')
    expect(parseIwSurvey(text)).toEqual([
      { freqMhz: 5180, channel: 36, busyPct: 42, noiseDbm: -92, inUse: true },
    ])
  })

  it('reads nmcli terse output, unescaping colons in the BSSID', () => {
    const text = [
      '*:11\\:22\\:33\\:44\\:4E\\:21:CREW:5180 MHz:84:WPA2 WPA3',
      ' :66\\:77\\:88\\:99\\:9A\\:07:Cafe\\: Wi-Fi:2412 MHz:30:',
    ].join('\n')
    const [crew, cafe] = parseNmcliWifi(text)
    expect(crew).toMatchObject({ ssid: 'CREW', channel: 36, signalPct: 84, connected: true })
    expect(cafe).toMatchObject({
      ssid: 'Cafe: Wi-Fi',
      bssid: '66:77:88:99:9a:07',
      security: 'open',
    })
  })

  it('numbers channels on all three bands', () => {
    expect([2412, 2437, 2484, 5180, 5745, 5955, 6115].map(channelOf)).toEqual([
      1, 6, 14, 36, 149, 1, 33,
    ])
  })
})

/** A machine with one wireless adapter, whose tools answer as `answers` says. */
function fakeIo(
  platform: NodeJS.Platform,
  answers: Record<string, string | Error>,
  files: Record<string, string> = {}
): SystemIo & { calls: string[][] } {
  const calls: string[][] = []
  const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
  return {
    platform,
    calls,
    readFile: async (path) => {
      if (path in files) return files[path]!
      throw enoent()
    },
    listDir: async (path) => {
      if (path === '/sys/class/net') return ['eth0', 'wlan0']
      if (path === '/sys/class/net/wlan0/wireless') return []
      throw enoent()
    },
    run: async (cmd, args) => {
      calls.push([cmd, ...args])
      const answer = answers[cmd]
      if (answer === undefined) throw enoent()
      if (answer instanceof Error) throw answer
      return answer
    },
    interfaces: () => ({}),
  }
}

describe('reading Wi-Fi never starts a scan', () => {
  it('prefers iw, asking only for what is cached', async () => {
    const io = fakeIo('linux', {
      iw: 'BSS 11:22:33:44:4e:21(on wlan0)\n\tfreq: 2412\n\tSSID: CREW',
    })
    const r = await readWifi(io)
    expect(r.available).toBe(true)
    expect(r.value?.source).toBe('iw')
    expect(io.calls).toEqual([
      ['iw', 'dev', 'wlan0', 'scan', 'dump'],
      ['iw', 'dev', 'wlan0', 'survey', 'dump'],
    ])
  })

  it('falls back to NetworkManager’s list with --rescan no', async () => {
    const io = fakeIo('linux', { nmcli: '*:11\\:22\\:33\\:44\\:4E\\:21:CREW:5180 MHz:84:WPA2' })
    const r = await readWifi(io)
    expect(r.value?.source).toBe('nmcli')
    const nmcli = io.calls.find((c) => c[0] === 'nmcli')!
    expect(nmcli.slice(-2)).toEqual(['--rescan', 'no'])
  })

  it('says why when there is nothing to read with', async () => {
    expect((await readWifi(fakeIo('linux', {}))).reason).toMatch(/neither iw nor NetworkManager/)
    expect((await readWifi(fakeIo('darwin', {}))).reason).toMatch(/Location Services/)
    expect((await readWifi(fakeIo('win32', {}))).reason).toMatch(/location access/)
  })
})

describe('reading the neighbour table', () => {
  it('runs arp with -n on a Mac, so no address is looked up in DNS', async () => {
    const io = fakeIo('darwin', { arp: '? (10.0.0.1) at 0:1b:c:2:3:4 on en0 ifscope [ethernet]' })
    const r = await readNeighbours(io)
    expect(r.value).toHaveLength(1)
    expect(io.calls).toEqual([['arp', '-an']])
  })

  it('reads /proc on Linux and runs nothing', async () => {
    const io = fakeIo(
      'linux',
      {},
      {
        '/proc/net/arp':
          'IP address HW type Flags HW address Mask Device\n10.0.0.1 0x1 0x2 aa:bb:cc:00:00:01 * wlan0\n',
      }
    )
    expect((await readNeighbours(io)).value).toHaveLength(1)
    expect(io.calls).toEqual([])
  })
})
