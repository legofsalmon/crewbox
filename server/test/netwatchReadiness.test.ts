import { describe, expect, it } from 'vitest'
import { mediaReadiness } from '../src/netwatch/readiness.ts'
import type { NetWatchStatus } from '../src/netwatch/listener.ts'
import type { ClockStatus } from '../src/netwatch/ptp.ts'
import type { MediaService } from '../src/netwatch/mdns.ts'
import type { SapStream } from '../src/netwatch/sap.ts'
import type { SdpCheck } from '../src/netwatch/sdp.ts'
import type { VideoClockDomain, VideoClockFinding } from '../src/netwatch/st2059.ts'

const NOW = 10_000_000

const status = (over: Partial<NetWatchStatus> = {}): NetWatchStatus => ({
  ptp: { listening: true, error: null, packets: 100 },
  mdns: { listening: true, error: null, packets: 100 },
  sap: { listening: true, error: null, packets: 10 },
  interfaceIp: '10.10.0.2',
  checks: null,
  ...over,
})

const clock = (over: Partial<ClockStatus> = {}): ClockStatus => ({
  grandmasterId: '00:1d:c1:ff:fe:11:22:33',
  domain: 0,
  domains: 1,
  priority1: 128,
  clockClass: 248,
  since: NOW - 3_600_000,
  lastAnnounce: NOW - 1000,
  changes: [{ at: NOW - 3_600_000, from: null, to: '00:1d:c1:ff:fe:11:22:33' }],
  announcers: 1,
  v1RateHz: 0,
  v1Seen: false,
  ...over,
})

const device = (over: Partial<MediaService> = {}): MediaService => ({
  name: 'foh-stagebox',
  kind: 'dante',
  address: '10.10.0.5',
  firstSeen: NOW - 3_600_000,
  lastSeen: NOW - 5000,
  saidGoodbye: false,
  ...over,
})

const find = (checks: ReturnType<typeof mediaReadiness>, id: string) =>
  checks.find((check) => check.id === id)

describe('the clock line', () => {
  it('reports a steady grandmaster as the good news it is', () => {
    const check = find(mediaReadiness(status(), clock(), [], [], NOW), 'media-clock')
    expect(check?.state).toBe('ok')
    expect(check?.detail).toContain('00:1D:C1')
    expect(check?.detail).toContain('steady since')
  })

  it('calls an election war what it is, with when and why it hurts', () => {
    const warring = clock({
      changes: [
        { at: NOW - 60_000, from: 'a', to: '00:1d:c1:ff:fe:11:22:33' },
        { at: NOW - 120_000, from: 'b', to: 'a' },
        { at: NOW - 200_000, from: 'a', to: 'b' },
      ],
    })
    const check = find(mediaReadiness(status(), warring, [], [], NOW), 'media-clock')
    expect(check?.state).toBe('limited')
    expect(check?.detail).toContain('changed 3 times')
    expect(check?.detail).toContain('audible')
    expect(check?.fix).toContain('preferred-master')
  })

  it('flags two clocks announcing at once', () => {
    const check = find(
      mediaReadiness(status(), clock({ announcers: 2 }), [], [], NOW),
      'media-clock-announcers'
    )
    expect(check?.state).toBe('limited')
    expect(check?.detail).toContain('2 clocks are announcing')
  })

  it('reports Dante-style v1 presence honestly, unnamed', () => {
    const v1 = clock({ grandmasterId: null, since: null, v1Seen: true, v1RateHz: 8, changes: [] })
    const check = find(mediaReadiness(status(), v1, [], [], NOW), 'media-clock')
    expect(check?.state).toBe('ok')
    expect(check?.detail).toContain('PTPv1')
    expect(check?.detail).toContain('presence only')
  })

  it('reads total silence as the wrong adapter, and names the fix', () => {
    const silent = clock({ grandmasterId: null, since: null, changes: [] })
    const check = find(mediaReadiness(status(), silent, [], [], NOW), 'media-clock')
    expect(check?.state).toBe('limited')
    expect(check?.fix).toContain('Media network adapter')
  })
})

describe('the rosters', () => {
  it('lists devices with how it knows', () => {
    const check = find(mediaReadiness(status(), clock(), [device()], [], NOW), 'media-dante')
    expect(check?.state).toBe('ok')
    expect(check?.detail).toContain('foh-stagebox')
    expect(check?.detail).toContain('10.10.0.5')
    // It does ask once, when an admin runs the deep probe, so "never" was
    // not true of a box whose admin had pressed the button.
    expect(check?.detail).toContain('asks only when an admin runs the deep probe')
  })

  it('turns a goodbye or a long silence into a check-the-power line', () => {
    const gone = device({ saidGoodbye: true })
    const check = find(mediaReadiness(status(), clock(), [gone], [], NOW), 'media-dante')
    expect(check?.state).toBe('limited')
    expect(check?.detail).toContain('said goodbye')
    expect(check?.fix).toContain('power')

    const stale = device({ lastSeen: NOW - 12 * 60_000 })
    const staleCheck = find(mediaReadiness(status(), clock(), [stale], [], NOW), 'media-dante')
    expect(staleCheck?.state).toBe('limited')
    expect(staleCheck?.detail).toContain('last heard 12 min ago')
  })

  it('keeps NDI and Dante apart, and says nothing about an absent kind', () => {
    const ndi = device({ kind: 'ndi', name: 'cam 1' })
    const checks = mediaReadiness(status(), clock(), [ndi], [], NOW)
    expect(find(checks, 'media-ndi')?.detail).toContain('cam 1')
    expect(find(checks, 'media-dante')).toBeUndefined()
  })

  it('lists AES67 streams with their destination', () => {
    const stream: SapStream = {
      name: 'Monitor Mix L/R',
      origin: '10.10.0.7',
      connection: '239.69.128.7',
      firstSeen: NOW - 60_000,
      lastSeen: NOW - 1000,
      sdp: null,
    }
    const check = find(mediaReadiness(status(), clock(), [], [stream], NOW), 'media-streams')
    expect(check?.detail).toContain('Monitor Mix L/R')
    expect(check?.detail).toContain('239.69.128.7')
  })
})

describe('NMOS', () => {
  const nmos = (name: string, api: 'query' | 'registration' | 'node', over = {}): MediaService =>
    device({
      name,
      kind: 'nmos',
      address: '10.20.0.5',
      nmos: { api, port: 8080, proto: 'http', versions: ['v1.2', 'v1.3'], priority: 10, ...over },
    })

  it('says where the registry is, preferred first, and counts the nodes', () => {
    const checks = mediaReadiness(
      status(),
      clock(),
      [
        nmos('backup', 'query', { priority: 20 }),
        nmos('main', 'query', { priority: 0 }),
        nmos('main', 'registration'),
        nmos('cam 1', 'node'),
        nmos('cam 2', 'node'),
      ],
      [],
      NOW
    )
    const line = find(checks, 'media-nmos')
    expect(line?.state).toBe('ok')
    expect(line?.detail).toBe(
      '2 registries: Query API at 10.20.0.5:8080 (v1.3, priority 0), ' +
        'Query API at 10.20.0.5:8080 (v1.3, priority 20); 2 nodes announcing their Node API. ' +
        'The deep probe reads the registry and checks what is registered there.'
    )
    // NMOS kit is not Dante.
    expect(find(checks, 'media-dante')).toBeUndefined()
  })

  it('names a registry heard only by its Registration API, and nodes on their own', () => {
    const registration = find(
      mediaReadiness(status(), clock(), [nmos('main', 'registration')], [], NOW),
      'media-nmos'
    )
    expect(registration?.detail).toContain("A registry's Registration API at 10.20.0.5:8080")
    const nodes = find(
      mediaReadiness(status(), clock(), [nmos('cam 1', 'node')], [], NOW),
      'media-nmos'
    )
    expect(nodes?.detail).toBe('1 node announcing their Node API.')
  })
})

describe('ST 2110 streams', () => {
  const aes67: SapStream = {
    name: 'Monitor Mix L/R',
    origin: '10.10.0.7',
    connection: '239.69.128.7',
    firstSeen: NOW - 60_000,
    lastSeen: NOW - 1000,
    sdp: { st2110: false, streams: [], problems: [] },
  }
  const camera = (name: string, over: Partial<SdpCheck> = {}): SapStream => ({
    name,
    origin: '10.0.0.1',
    connection: '239.1.1.1',
    firstSeen: NOW - 60_000,
    lastSeen: NOW - 1000,
    sdp: {
      st2110: true,
      streams: [
        {
          essence: 'video',
          summary: '1920x1080 progressive, 50 fps',
          destination: '239.1.1.1',
          bitrate: 2_073_600_000,
        },
      ],
      problems: [],
      ...over,
    },
  })
  const refused = {
    severity: 'error' as const,
    rule: 'ts-refclk-missing',
    message: 'no a=ts-refclk, so receivers cannot tell which clock the timestamps follow',
    line: 5,
  }

  it('get a line of their own, apart from the AES67 streams', () => {
    const checks = mediaReadiness(status(), clock(), [], [aes67, camera('CAM 1')], NOW)
    expect(find(checks, 'media-streams')?.detail).toContain('Monitor Mix L/R')
    expect(find(checks, 'media-streams')?.detail).not.toContain('CAM 1')
    const line = find(checks, 'media-st2110-streams')
    expect(line?.state).toBe('ok')
    expect(line?.detail).toContain('CAM 1 (video at 2.07 Gb/s → 239.1.1.1)')
    expect(line?.detail).toContain('never joins')
    expect(line?.fix).toBeUndefined()
  })

  it('say which file a receiver would refuse, and where in it', () => {
    const checks = mediaReadiness(
      status(),
      clock(),
      [],
      [camera('CAM 1'), camera('CAM 2', { problems: [refused] })],
      NOW
    )
    const line = find(checks, 'media-st2110-streams')
    expect(line?.state).toBe('limited')
    expect(line?.detail).toContain(`CAM 2: ${refused.message} (line 5)`)
    expect(line?.fix).toMatch(/at the sender/)
  })

  it('mention a warning without calling the stream faulty', () => {
    const warning = { ...refused, severity: 'warning' as const, rule: 'source-filter-missing' }
    const line = find(
      mediaReadiness(status(), clock(), [], [camera('CAM 3', { problems: [warning] })], NOW),
      'media-st2110-streams'
    )
    expect(line?.state).toBe('ok')
    expect(line?.detail).toContain('Worth a look: CAM 3')
  })

  it('stay with the AES67 streams until their files have been checked', () => {
    const unchecked = { ...camera('CAM 4'), sdp: null }
    const checks = mediaReadiness(status(), clock(), [], [unchecked], NOW)
    expect(find(checks, 'media-streams')?.detail).toContain('CAM 4')
    expect(find(checks, 'media-st2110-streams')).toBeUndefined()
  })

  it('are listed unchecked when the checks could not load, and the line says so', () => {
    const checks = mediaReadiness(
      status({ checks: 'CompileError: bad magic' }),
      clock(),
      [],
      [],
      NOW
    )
    const line = find(checks, 'media-st2110-checks')
    expect(line?.state).toBe('limited')
    expect(line?.detail).toContain('CompileError: bad magic')
    expect(
      find(mediaReadiness(status(), clock(), [], [], NOW), 'media-st2110-checks')
    ).toBeUndefined()
  })
})

describe('the watchers themselves', () => {
  it('names a watcher that could not open, without silencing the rest', () => {
    const broken = status({ ptp: { listening: false, error: 'EADDRINUSE', packets: 0 } })
    const check = find(mediaReadiness(broken, clock(), [], [], NOW), 'media-watchers')
    expect(check?.state).toBe('limited')
    expect(check?.detail).toContain('EADDRINUSE')
    expect(check?.fix).toContain('Dante Virtual Soundcard')
  })
})

describe('the video clock', () => {
  const OVERFLOW = { devices: 0, streams: 0 }
  const domain = (over: Partial<VideoClockDomain> = {}): VideoClockDomain => ({
    domain: 127,
    grandmaster: '08:00:11:ff:fe:21:e1:b0',
    clockClass: 6,
    ptpTimescale: true,
    utcOffset: 37,
    metadata: {
      frameRate: '50/1',
      dropFrame: false,
      locking: 'externally locked',
      localOffset: 3563,
      lastSeen: NOW,
    },
    findings: [],
    lastHeard: NOW,
    ...over,
  })
  const finding = (over: Partial<VideoClockFinding>): VideoClockFinding => ({
    rule: 'sync-interval',
    severity: 'error',
    message: 'logMessageInterval is 0 (one a second), outside −7 to −1',
    messageType: 'Sync',
    source: '08:00:11:ff:fe:21:e1:b0',
    lastSeen: NOW,
    ...over,
  })
  const line = (video: VideoClockDomain[]) =>
    find(mediaReadiness(status(), clock(), [], [], NOW, OVERFLOW, video), 'media-video-clock')

  it('is absent where no domain runs the SMPTE profile', () => {
    expect(line([])).toBeUndefined()
    expect(
      find(mediaReadiness(status(), clock(), [], [], NOW), 'media-video-clock')
    ).toBeUndefined()
  })

  it('describes a healthy video clock', () => {
    const check = line([domain()])
    expect(check?.state).toBe('ok')
    expect(check?.detail).toBe(
      'Domain 127: grandmaster 08:00:11:21:E1:B0, locked (class 6); ' +
        '50 fps, externally locked, local time UTC+01:00.'
    )
    expect(check?.fix).toBeUndefined()
  })

  it('names what breaks the profile, and who sent it', () => {
    const check = line([domain({ findings: [finding({})] })])
    expect(check?.state).toBe('limited')
    expect(check?.detail).toMatch(
      /^Breaks ST 2059-2: Sync from 08:00:11:21:E1:B0: logMessageInterval is 0 \(one a second\)/
    )
    expect(check?.fix).toMatch(/SMPTE ST 2059-2 profile/)
  })

  it('mentions a doubtful setting without calling the clock broken', () => {
    const jump = finding({
      rule: 'sm-jump',
      severity: 'warning',
      message: 'jumpSeconds is -3600 but timeOfNextJump is 0',
      messageType: 'Management',
    })
    const described = finding({ rule: 'gm-clock-class', severity: 'warning', message: 'x' })
    const check = line([domain({ findings: [jump, described] })])
    expect(check?.state).toBe('ok')
    expect(check?.detail).toContain('Worth a look: Management from 08:00:11:21:E1:B0: jumpSeconds')
    expect(check?.detail).not.toContain('x.')
  })
})
