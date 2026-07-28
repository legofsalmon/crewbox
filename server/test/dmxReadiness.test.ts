import { describe, expect, it } from 'vitest'
import { dmxReadiness } from '../src/dmx/readiness.ts'
import type { DmxListenerStatus } from '../src/dmx/listener.ts'
import type { UniverseHealth } from '../src/dmx/state.ts'

const NOW = 1_000_000

const status = (over: Partial<DmxListenerStatus> = {}): DmxListenerStatus => ({
  mode: 'both',
  artnet: { listening: true, error: null },
  sacn: { listening: true, error: null, joined: [1, 2], failed: [] },
  interfaceIp: '2.0.0.5',
  packets: 0,
  ignored: 0,
  ...over,
})

const universe = (over: Partial<UniverseHealth> = {}): UniverseHealth => ({
  universe: 1,
  wireUniverse: 1,
  protocol: 'sacn',
  sources: [
    { id: 'a', name: 'grandMA3', protocol: 'sacn', priority: 100, lastSeen: NOW - 200, rateHz: 44 },
  ],
  winnerId: 'a',
  conflict: false,
  lastSeen: NOW - 200,
  since: NOW - 60_000,
  ...over,
})

const find = (checks: ReturnType<typeof dmxReadiness>, id: string) =>
  checks.find((check) => check.id === id)

describe('the three states that look the same from inside the app', () => {
  it('says plainly when it was never asked to listen', () => {
    const checks = dmxReadiness(status({ mode: 'off' }), [], NOW)
    expect(checks).toHaveLength(1)
    expect(checks[0].state).toBe('off')
    expect(checks[0].fix).toContain('CREWBOX_DMX')
  })

  it('distinguishes listening-and-silent from not listening', () => {
    const checks = dmxReadiness(status(), [], NOW)
    expect(find(checks, 'dmx-artnet')?.state).toBe('ok')
    const traffic = find(checks, 'dmx-traffic')
    expect(traffic?.state).toBe('limited')
    // The causes worth checking, in the order worth checking them.
    expect(traffic?.fix).toContain('VLAN')
    expect(traffic?.fix).toContain('IGMP')
    expect(traffic?.fix).toContain('unicasts')
  })

  it('reports what is on the wire once anything arrives', () => {
    const checks = dmxReadiness(status(), [universe()], NOW)
    const traffic = find(checks, 'dmx-traffic')
    expect(traffic?.state).toBe('ok')
    expect(traffic?.detail).toContain('1 universe')
    expect(traffic?.detail).toContain('grandMA3')
  })

  it('does not count a universe whose sources have all gone as live', () => {
    const checks = dmxReadiness(status({ packets: 900 }), [universe({ sources: [] })], NOW)
    expect(find(checks, 'dmx-traffic')?.state).toBe('limited')
    expect(find(checks, 'dmx-traffic')?.detail).toContain('900 packets')
  })
})

describe('faults worth shouting about', () => {
  it('names both sources when two are on one universe', () => {
    const conflicted = universe({
      conflict: true,
      sources: [
        { id: 'a', name: 'grandMA3', protocol: 'sacn', priority: 100, lastSeen: NOW, rateHz: 44 },
        { id: 'b', name: 'Spare Desk', protocol: 'sacn', priority: 100, lastSeen: NOW, rateHz: 44 },
      ],
    })
    const check = find(dmxReadiness(status(), [conflicted], NOW), 'dmx-conflict')
    expect(check?.state).toBe('limited')
    expect(check?.detail).toContain('grandMA3')
    expect(check?.detail).toContain('Spare Desk')
    expect(check?.fix).toContain('priorities')
  })

  it('stays quiet when there is no conflict', () => {
    expect(find(dmxReadiness(status(), [universe()], NOW), 'dmx-conflict')).toBeUndefined()
  })

  it('explains which universes could not be joined and why', () => {
    const checks = dmxReadiness(
      status({
        sacn: {
          listening: true,
          error: null,
          joined: [1],
          failed: [{ universe: 2, reason: 'over the 16 limit' }],
        },
      }),
      [universe()],
      NOW
    )
    const check = find(checks, 'dmx-sacn')
    expect(check?.state).toBe('limited')
    expect(check?.fix).toContain('igmp_max_memberships')
  })

  it('warns about a missing interface only when one was not set', () => {
    expect(find(dmxReadiness(status(), [universe()], NOW), 'dmx-sacn')?.fix).toBeUndefined()
    const noIface = dmxReadiness(status({ interfaceIp: null }), [universe()], NOW)
    expect(find(noIface, 'dmx-sacn')?.fix).toContain('CREWBOX_DMX_IFACE')
  })
})

describe('the universe mapping', () => {
  it('shows both numbers for Art-Net so a wrong base is visible', () => {
    // A wrong base checks every fixture against the wrong universe — 512
    // channels out, and invisible unless the mapping is stated.
    const artnet = universe({ protocol: 'artnet', universe: 1, wireUniverse: 0 })
    const check = find(dmxReadiness(status(), [artnet], NOW), 'dmx-mapping')
    expect(check?.detail).toBe('Art-Net 0 → plot universe 1')
    expect(check?.fix).toContain('CREWBOX_DMX_ARTNET_BASE')
  })

  it('says nothing about mapping when only sACN is arriving', () => {
    // sACN and a plot both count from 1, so there is nothing to explain.
    expect(find(dmxReadiness(status(), [universe()], NOW), 'dmx-mapping')).toBeUndefined()
  })
})
