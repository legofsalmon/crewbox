import { describe, expect, it } from 'vitest'
import { mediaReadiness } from '../src/netwatch/readiness.ts'
import type { NetWatchStatus } from '../src/netwatch/listener.ts'
import type { ClockStatus } from '../src/netwatch/ptp.ts'
import type { MediaService } from '../src/netwatch/mdns.ts'
import type { SapStream } from '../src/netwatch/sap.ts'

const NOW = 10_000_000

const status = (over: Partial<NetWatchStatus> = {}): NetWatchStatus => ({
  ptp: { listening: true, error: null, packets: 100 },
  mdns: { listening: true, error: null, packets: 100 },
  sap: { listening: true, error: null, packets: 10 },
  interfaceIp: '10.10.0.2',
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
    expect(check?.fix).toContain('CREWBOX_WATCH_IFACE')
  })
})

describe('the rosters', () => {
  it('lists devices with how it knows', () => {
    const check = find(mediaReadiness(status(), clock(), [device()], [], NOW), 'media-dante')
    expect(check?.state).toBe('ok')
    expect(check?.detail).toContain('foh-stagebox')
    expect(check?.detail).toContain('10.10.0.5')
    expect(check?.detail).toContain('never queries')
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
    }
    const check = find(mediaReadiness(status(), clock(), [], [stream], NOW), 'media-streams')
    expect(check?.detail).toContain('Monitor Mix L/R')
    expect(check?.detail).toContain('239.69.128.7')
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
