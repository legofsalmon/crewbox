import { describe, expect, it } from 'vitest'
import { dmxReadiness } from '../src/dmx/readiness.ts'
import type { DmxListenerStatus } from '../src/dmx/listener.ts'
import type { ArtNode, DiscoveredSource, DmxOutage, UniverseHealth } from '../src/dmx/state.ts'

const NOW = 1_000_000

const status = (over: Partial<DmxListenerStatus> = {}): DmxListenerStatus => ({
  mode: 'both',
  artnet: { listening: true, error: null },
  sacn: { listening: true, error: null, joined: [1, 2], failed: [], discovery: true },
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
    {
      id: 'a',
      name: 'grandMA3',
      protocol: 'sacn',
      priority: 100,
      lastSeen: NOW - 200,
      rateHz: 44,
      lossPct: null,
    },
  ],
  winnerId: 'a',
  conflict: false,
  sync: 'none',
  syncAddress: 0,
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
        {
          id: 'a',
          name: 'grandMA3',
          protocol: 'sacn',
          priority: 100,
          lastSeen: NOW,
          rateHz: 44,
          lossPct: null,
        },
        {
          id: 'b',
          name: 'Spare Desk',
          protocol: 'sacn',
          priority: 100,
          lastSeen: NOW,
          rateHz: 44,
          lossPct: null,
        },
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
          discovery: true,
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

describe('whether what is on the wire is on stage', () => {
  it('says nothing when nothing is synchronising', () => {
    const checks = dmxReadiness(status(), [universe()], NOW)
    expect(find(checks, 'dmx-sync')).toBeUndefined()
  })

  it('warns that a frozen stage has stopped following the desk', () => {
    // The fault worth the whole feature: the desk keeps sending, this panel
    // keeps showing levels moving, and the rig has not changed since the sync
    // stream died. Nothing else in the panel would notice.
    const checks = dmxReadiness(status(), [universe({ sync: 'frozen', syncAddress: 7962 })], NOW)
    const check = find(checks, 'dmx-sync')
    expect(check?.state).toBe('limited')
    expect(check?.detail).toContain('7962')
    expect(check?.detail).toContain('last look')
  })

  it('does not claim a stage stopped when the sources allowed it to carry on', () => {
    const check = find(
      dmxReadiness(status(), [universe({ sync: 'lost', syncAddress: 7962 })], NOW),
      'dmx-sync'
    )
    expect(check?.state).toBe('limited')
    expect(check?.detail).not.toContain('last look')
  })

  it('names the universe to add when the sync stream cannot be seen', () => {
    const check = find(
      dmxReadiness(status(), [universe({ sync: 'unwatched', syncAddress: 7962 })], NOW),
      'dmx-sync'
    )
    expect(check?.fix).toContain('7962')
    expect(check?.fix).toContain('CREWBOX_DMX_UNIVERSES')
  })

  it('reports working synchronisation as ok, but says the levels are queued', () => {
    const check = find(
      dmxReadiness(status(), [universe({ sync: 'held', syncAddress: 7962 })], NOW),
      'dmx-sync'
    )
    expect(check?.state).toBe('ok')
    expect(check?.detail).toContain('queued')
  })

  it('leads with the failure when one universe is stuck and another is fine', () => {
    const check = find(
      dmxReadiness(
        status(),
        [
          universe({ sync: 'held', syncAddress: 7962 }),
          universe({ universe: 2, sync: 'frozen', syncAddress: 7962 }),
        ],
        NOW
      ),
      'dmx-sync'
    )
    expect(check?.state).toBe('limited')
  })
})

describe('more sources than a node will merge', () => {
  const two = [
    {
      id: 'a',
      name: 'Console A',
      protocol: 'artnet' as const,
      priority: 100,
      lastSeen: NOW,
      rateHz: 44,
      lossPct: null,
    },
    {
      id: 'b',
      name: 'Console B',
      protocol: 'artnet' as const,
      priority: 100,
      lastSeen: NOW,
      rateHz: 44,
      lossPct: null,
    },
  ]

  it('says nothing extra about an ordinary two-way conflict', () => {
    const check = find(
      dmxReadiness(status(), [universe({ protocol: 'artnet', conflict: true, sources: two })], NOW),
      'dmx-conflict'
    )
    expect(check?.fix).not.toContain('discarded')
  })

  it('points out that a third Art-Net source is being thrown away', () => {
    // Not a louder argument — a console nobody is listening to. The Art-Net 4
    // specification's data merging section limits a node to two sources and
    // has it ignore the rest.
    const three = [
      ...two,
      {
        id: 'c',
        name: 'Media Server',
        protocol: 'artnet' as const,
        priority: 100,
        lastSeen: NOW,
        rateHz: 44,
        lossPct: null,
      },
    ]
    const check = find(
      dmxReadiness(
        status(),
        [universe({ protocol: 'artnet', conflict: true, sources: three })],
        NOW
      ),
      'dmx-conflict'
    )
    expect(check?.fix).toContain('discarded')
  })

  it('does not claim the limit applies to sACN', () => {
    const three = [
      {
        id: 'a',
        name: 'A',
        protocol: 'sacn' as const,
        priority: 100,
        lastSeen: NOW,
        rateHz: 44,
        lossPct: null,
      },
      {
        id: 'b',
        name: 'B',
        protocol: 'sacn' as const,
        priority: 100,
        lastSeen: NOW,
        rateHz: 44,
        lossPct: null,
      },
      {
        id: 'c',
        name: 'C',
        protocol: 'sacn' as const,
        priority: 100,
        lastSeen: NOW,
        rateHz: 44,
        lossPct: null,
      },
    ]
    const check = find(
      dmxReadiness(status(), [universe({ conflict: true, sources: three })], NOW),
      'dmx-conflict'
    )
    expect(check?.fix).not.toContain('discarded')
  })
})

describe('what the desks say they are sending', () => {
  const source = (over: Partial<DiscoveredSource> = {}): DiscoveredSource => ({
    id: 'desk-a',
    name: 'grandMA3',
    universes: [1, 2],
    complete: true,
    pagesSeen: 1,
    pages: 1,
    lastSeen: NOW,
    ...over,
  })

  it('says nothing when nothing has advertised itself', () => {
    // Legacy sources need not implement discovery at all (§12), so silence
    // here is not a fault and must not read like one.
    expect(find(dmxReadiness(status(), [universe()], NOW, []), 'dmx-discovery')).toBeUndefined()
  })

  it('lists what each source claims', () => {
    const check = find(dmxReadiness(status(), [universe()], NOW, [source()]), 'dmx-discovery')
    expect(check?.state).toBe('ok')
    expect(check?.detail).toContain('grandMA3')
    expect(check?.detail).toContain('1-2')
  })

  it('names the universes to add when a desk is sending more than we joined', () => {
    // The whole point. Listening to 1-2 while the desk sends 1-8 looks, from
    // every other check in this panel, like a network fault. It is a typo in
    // one environment variable.
    const check = find(
      dmxReadiness(status(), [universe()], NOW, [source({ universes: [1, 2, 3, 4, 5, 6, 7, 8] })]),
      'dmx-discovery'
    )
    expect(check?.state).toBe('limited')
    expect(check?.fix).toContain('3-8')
    expect(check?.fix).toContain('CREWBOX_DMX_UNIVERSES')
  })

  it('appears even when no data is arriving, which is when it matters most', () => {
    const checks = dmxReadiness(status(), [], NOW, [source({ universes: [1, 2, 3] })])
    expect(find(checks, 'dmx-discovery')).toBeDefined()
    // ...alongside, not instead of, the "nothing arriving" report.
    expect(find(checks, 'dmx-traffic')?.state).toBe('limited')
  })

  it('admits when a list is only the pages that arrived', () => {
    const check = find(
      dmxReadiness(status(), [universe()], NOW, [
        source({ complete: false, pagesSeen: 2, pages: 3 }),
      ]),
      'dmx-discovery'
    )
    expect(check?.detail).toContain('2 of 3 pages')
    expect(check?.detail).toContain('not necessarily everything')
  })

  it('collapses a long run rather than printing 32 numbers at someone', () => {
    const many = Array.from({ length: 32 }, (_, i) => i + 1)
    const check = find(
      dmxReadiness(
        status({
          sacn: { listening: true, error: null, joined: many, failed: [], discovery: true },
        }),
        [universe()],
        NOW,
        [source({ universes: many })]
      ),
      'dmx-discovery'
    )
    expect(check?.detail).toContain('1-32')
  })
})

describe('everything going dark at once', () => {
  const outage = (over: Partial<DmxOutage> = {}): DmxOutage => ({
    protocol: 'sacn',
    at: NOW - 30_000,
    universes: [1, 2, 3],
    otherProtocolAlive: false,
    ...over,
  })

  it('names the collapse as one network fault, not many desk faults', () => {
    const checks = dmxReadiness(status(), [universe({ sources: [] })], NOW, [], [], [outage()])
    const check = find(checks, 'dmx-outage-sacn')
    expect(check?.state).toBe('limited')
    expect(check?.detail).toContain('1-3')
    expect(check?.detail).toContain('within moments of each other')
    expect(check?.detail).toContain('network fault')
    // ...alongside, not instead of, the plain nothing-arriving report.
    expect(find(checks, 'dmx-traffic')?.state).toBe('limited')
  })

  it('points at the switch when broadcast survived what multicast did not', () => {
    const check = find(
      dmxReadiness(status(), [], NOW, [], [], [outage({ otherProtocolAlive: true })]),
      'dmx-outage-sacn'
    )
    expect(check?.detail).toContain('Art-Net broadcast is still arriving')
    expect(check?.detail).toContain('not at the desk')
    expect(check?.fix).toContain('IGMP')
  })

  it('says when it happened, in wall-clock time someone can act on', () => {
    const at = new Date('2026-08-06T14:32:00').getTime()
    const check = find(dmxReadiness(status(), [], NOW, [], [], [outage({ at })]), 'dmx-outage-sacn')
    expect(check?.detail).toContain('14:32')
  })

  it('stays silent when there is no outage', () => {
    expect(find(dmxReadiness(status(), [universe()], NOW), 'dmx-outage-sacn')).toBeUndefined()
  })
})

describe('frames going missing', () => {
  const lossy = (lossPct: number | null) =>
    universe({
      sources: [
        {
          id: 'a',
          name: 'grandMA3',
          protocol: 'sacn',
          priority: 100,
          lastSeen: NOW,
          rateHz: 44,
          lossPct,
        },
      ],
    })

  it('names the universe, the source and the number', () => {
    const check = find(dmxReadiness(status(), [lossy(0.03)], NOW), 'dmx-loss')
    expect(check?.state).toBe('limited')
    expect(check?.detail).toContain('Universe 1')
    expect(check?.detail).toContain('3%')
    expect(check?.detail).toContain('grandMA3')
    expect(check?.fix).toContain('path')
  })

  it('keeps rounding noise off the panel', () => {
    expect(find(dmxReadiness(status(), [lossy(0.004)], NOW), 'dmx-loss')).toBeUndefined()
  })

  it('treats "cannot say" as nothing to report, not as zero-and-fine', () => {
    expect(find(dmxReadiness(status(), [lossy(null)], NOW), 'dmx-loss')).toBeUndefined()
  })
})

describe('the node inventory', () => {
  const node = (over: Partial<ArtNode> = {}): ArtNode => ({
    ip: '2.0.0.7',
    name: 'SL Node',
    longName: 'Stage Left Node',
    firstSeen: NOW - 3_600_000,
    lastSeen: NOW - 1000,
    ...over,
  })

  it('lists who has announced themselves, and how it knows', () => {
    const check = find(dmxReadiness(status(), [universe()], NOW, [], [node()]), 'dmx-nodes')
    expect(check?.state).toBe('ok')
    expect(check?.detail).toContain('SL Node')
    expect(check?.detail).toContain('2.0.0.7')
    expect(check?.detail).toContain('never polls')
  })

  it('marks a node that has stopped announcing itself', () => {
    const check = find(
      dmxReadiness(status(), [universe()], NOW, [], [node({ lastSeen: NOW - 12 * 60_000 })]),
      'dmx-nodes'
    )
    expect(check?.detail).toContain('last seen 12 min ago')
  })

  it('survives the nothing-arriving early return, where it matters most', () => {
    const checks = dmxReadiness(status(), [], NOW, [], [node()])
    expect(find(checks, 'dmx-nodes')).toBeDefined()
    expect(find(checks, 'dmx-traffic')?.state).toBe('limited')
  })
})
