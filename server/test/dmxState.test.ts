import { describe, expect, it } from 'vitest'
import { DmxState, signedByteDiff } from '../src/dmx/state.ts'
import type { SacnDiscovery } from '../src/dmx/sacn.ts'
import { DEFAULT_PRIORITY, type DmxFrame } from '../src/dmx/types.ts'

/**
 * These tests own the clock. Every timing rule in E1.31 — the 2.5 s data-loss
 * timeout, the sequence window — is a pure function of the timestamps handed
 * to `apply` and `sweep`, so none of this needs a socket or a wait.
 */

const frame = (over: Partial<DmxFrame> = {}): DmxFrame => ({
  protocol: 'sacn',
  wireUniverse: 1,
  sourceId: 'console-a',
  sourceName: 'Console A',
  priority: DEFAULT_PRIORITY,
  sequence: 1,
  sequenced: true,
  slots: new Uint8Array([0, 0, 0, 0]),
  syncAddress: 0,
  forceSync: false,
  preview: false,
  terminated: false,
  ...over,
})

/** Levels at 1-based addresses, in a 512-slot frame. */
const levels = (lit: Record<number, number>): Uint8Array => {
  const slots = new Uint8Array(512)
  for (const [address, level] of Object.entries(lit)) slots[Number(address) - 1] = level
  return slots
}

describe('mapping the wire onto a plot', () => {
  it('offsets Art-Net, which counts from zero, and leaves sACN alone', () => {
    // Getting this wrong moves every fixture 512 channels — invisible on
    // paper, extremely visible on stage.
    const state = new DmxState({ artnetBase: 1 })
    expect(state.plotUniverse({ protocol: 'artnet', wireUniverse: 0 })).toBe(1)
    expect(state.plotUniverse({ protocol: 'artnet', wireUniverse: 3 })).toBe(4)
    expect(state.plotUniverse({ protocol: 'sacn', wireUniverse: 1 })).toBe(1)
  })

  it('takes a different base when a rig is configured differently', () => {
    const state = new DmxState({ artnetBase: 0 })
    expect(state.plotUniverse({ protocol: 'artnet', wireUniverse: 0 })).toBe(0)
    expect(state.plotUniverse({ protocol: 'artnet', wireUniverse: 1 })).toBe(1)
  })

  it('keeps the wire number so both can be shown together', () => {
    const state = new DmxState({ artnetBase: 1 })
    state.apply(frame({ protocol: 'artnet', wireUniverse: 0, sequenced: false }), 1000)
    const [health] = state.health()
    expect(health.universe).toBe(1)
    expect(health.wireUniverse).toBe(0)
  })
})

describe('who is sending', () => {
  it('records a source and the universe it is on', () => {
    const state = new DmxState()
    state.apply(frame(), 1000)
    const [health] = state.health()
    expect(health.universe).toBe(1)
    expect(health.sources).toHaveLength(1)
    expect(health.sources[0].name).toBe('Console A')
    expect(health.winnerId).toBe('console-a')
    expect(health.conflict).toBe(false)
  })

  it('lets the higher priority win without calling it a conflict', () => {
    const state = new DmxState()
    state.apply(frame({ sourceId: 'a', priority: 100 }), 1000)
    state.apply(frame({ sourceId: 'b', priority: 150, slots: levels({ 1: 200 }) }), 1001)
    const [health] = state.health()
    expect(health.winnerId).toBe('b')
    expect(health.conflict).toBe(false)
    expect(state.levels(1)![0]).toBe(200)
  })

  it('calls an equal-priority tie a conflict', () => {
    // Two consoles patched to one universe is a classic festival fault that
    // runs a whole show before anyone notices, because E1.31 leaves what a
    // receiver does about it undefined.
    const state = new DmxState()
    state.apply(frame({ sourceId: 'a', priority: 100 }), 1000)
    state.apply(frame({ sourceId: 'b', priority: 100 }), 1001)
    expect(state.health()[0].conflict).toBe(true)
  })

  it('stops calling it a conflict once one of them goes away', () => {
    const state = new DmxState()
    state.apply(frame({ sourceId: 'a' }), 1000)
    state.apply(frame({ sourceId: 'b' }), 1000)
    expect(state.health()[0].conflict).toBe(true)
    state.apply(frame({ sourceId: 'b', terminated: true }), 1100)
    expect(state.health()[0].conflict).toBe(false)
    expect(state.health()[0].winnerId).toBe('a')
  })

  it('handles a termination arriving three times', () => {
    // Which is what the standard says a source does on the way out.
    const state = new DmxState()
    state.apply(frame({ sourceId: 'a' }), 1000)
    for (const t of [1100, 1101, 1102]) {
      state.apply(frame({ sourceId: 'a', terminated: true }), t)
    }
    expect(state.health()[0].sources).toHaveLength(0)
    expect(state.health()[0].winnerId).toBeNull()
  })

  it('drops a source that simply stops', () => {
    const state = new DmxState()
    state.apply(frame(), 1000)
    state.sweep(3000)
    expect(state.health()[0].sources).toHaveLength(1)
    // 2.5 s of silence is the standard's data-loss timeout.
    state.sweep(3600)
    expect(state.health()[0].sources).toHaveLength(0)
  })

  it('gives an Art-Net source the longer rope its protocol expects', () => {
    // The bug this pins: sACN sources stream continuously and E1.31 times
    // them out at 2.5 s, but an Art-Net sender parked on an unchanging look
    // is allowed to go quiet and re-send only every ~4 s. Judging it by
    // sACN's clock drops a healthy console between its own keep-alives, so
    // the panel flaps between "receiving" and "nothing arriving" for most of
    // a show — a monitor crying wolf is worse than no monitor.
    const state = new DmxState({ artnetBase: 0 })
    state.apply(frame({ protocol: 'artnet', sourceId: '2.0.0.7' }), 1000)

    // Well past sACN's timeout, and past a 4 s re-transmit interval.
    state.sweep(6000)
    expect(state.health()[0].sources).toHaveLength(1)

    // Two missed re-transmissions is genuinely gone.
    state.sweep(12_000)
    expect(state.health()[0].sources).toHaveLength(0)
  })

  it('times the two protocols independently on the same universe', () => {
    const state = new DmxState({ artnetBase: 0 })
    state.apply(frame({ protocol: 'sacn', sourceId: 'desk' }), 1000)
    state.apply(frame({ protocol: 'artnet', sourceId: '2.0.0.7' }), 1000)
    state.sweep(5000)
    expect(state.health()[0].sources.map((s) => s.protocol)).toEqual(['artnet'])
  })

  it('remembers the universe after every source has gone', () => {
    // "This universe was live and now nothing is sending it" is a much more
    // useful thing to say than forgetting it ever existed.
    const state = new DmxState()
    state.apply(frame(), 1000)
    state.sweep(9000)
    const [health] = state.health()
    expect(health.universe).toBe(1)
    expect(health.since).toBe(1000)
    expect(health.sources).toHaveLength(0)
  })

  it('names an Art-Net sender from a reply it volunteered', () => {
    const state = new DmxState()
    state.apply(frame({ protocol: 'artnet', sourceId: '2.0.0.7', sourceName: '' }), 1000)
    expect(state.health()[0].sources[0].name).toBe('')
    state.noteNode({ ip: '2.0.0.7', shortName: 'SL Node', longName: 'Stage Left Node' }, 1500)
    expect(state.health()[0].sources[0].name).toBe('Stage Left Node')
  })
})

describe('what gets believed', () => {
  it('ignores a console previewing a cue', () => {
    // A preview is a desk showing itself something it has not output. Counting
    // it would light up a plot for a rig that is dark.
    const state = new DmxState()
    state.apply(frame({ preview: true, slots: levels({ 1: 255 }) }), 1000)
    expect(state.health()).toHaveLength(0)
    expect(state.verdict(1, 1, 1)).toBe('no-data')
  })

  it('discards a packet the network reordered', () => {
    const state = new DmxState()
    state.apply(frame({ sequence: 10, slots: levels({ 1: 100 }) }), 1000)
    state.apply(frame({ sequence: 9, slots: levels({ 1: 255 }) }), 1001)
    expect(state.levels(1)![0]).toBe(100)
  })

  it('accepts the next frame after a wrap', () => {
    // 255 → 1 is two forwards, not 254 backwards. Reading it as backwards
    // would throw away a run of good packets every time the counter turns over.
    const state = new DmxState()
    state.apply(frame({ sequence: 255, slots: levels({ 1: 100 }) }), 1000)
    state.apply(frame({ sequence: 1, slots: levels({ 1: 255 }) }), 1001)
    expect(state.levels(1)![0]).toBe(255)
  })

  it('accepts a big jump forward, which is loss rather than reordering', () => {
    const state = new DmxState()
    state.apply(frame({ sequence: 10, slots: levels({ 1: 100 }) }), 1000)
    state.apply(frame({ sequence: 80, slots: levels({ 1: 255 }) }), 1001)
    expect(state.levels(1)![0]).toBe(255)
  })

  it('does not apply the sequence rule to unsequenced Art-Net', () => {
    const state = new DmxState()
    // Wire universe 0, because Art-Net counts from zero and the default base
    // puts that on plot universe 1.
    const artnet = {
      protocol: 'artnet' as const,
      wireUniverse: 0,
      sequenced: false,
      sequence: 0,
    }
    state.apply(frame({ ...artnet, slots: levels({ 1: 100 }) }), 1000)
    state.apply(frame({ ...artnet, slots: levels({ 1: 255 }) }), 1001)
    expect(state.levels(1)![0]).toBe(255)
  })

  it('clears slots the new frame is too short to cover', () => {
    // A source that drops from 512 slots to 4 has not left 508 channels lit.
    const state = new DmxState()
    state.apply(frame({ sequence: 1, slots: levels({ 1: 10, 400: 200 }) }), 1000)
    expect(state.levels(1)![399]).toBe(200)
    state.apply(frame({ sequence: 2, slots: new Uint8Array([10, 0, 0, 0]) }), 1001)
    expect(state.levels(1)![399]).toBe(0)
  })
})

describe('what can honestly be said about a fixture', () => {
  it('says no-data when the universe has never been heard', () => {
    const state = new DmxState()
    expect(state.verdict(5, 1, 16)).toBe('no-data')
  })

  it('says silent when the universe is live but these addresses never are', () => {
    // The whole point: "the desk is not sending this", which is different from
    // "this fixture is broken" and different again from "nothing is arriving".
    const state = new DmxState()
    state.apply(frame({ slots: levels({ 1: 255 }) }), 1000)
    expect(state.verdict(1, 17, 16)).toBe('silent')
  })

  it('says live once any address in the footprint has been above zero', () => {
    const state = new DmxState()
    state.apply(frame({ slots: levels({ 20: 4 }) }), 1000)
    // A Sharpy at 17 occupies 17–32, and 20 is in it.
    expect(state.verdict(1, 17, 16)).toBe('live')
    // A fixture at 33 is not.
    expect(state.verdict(1, 33, 16)).toBe('silent')
  })

  it('stays live after the level goes back to zero', () => {
    // Otherwise every fixture would read as broken between cues.
    const state = new DmxState()
    state.apply(frame({ sequence: 1, slots: levels({ 5: 255 }) }), 1000)
    state.apply(frame({ sequence: 2, slots: levels({ 5: 0 }) }), 1100)
    expect(state.levels(1)![4]).toBe(0)
    expect(state.verdict(1, 5, 1)).toBe('live')
  })

  it('does not run off the end of a universe', () => {
    const state = new DmxState()
    state.apply(frame({ slots: levels({ 512: 255 }) }), 1000)
    expect(state.verdict(1, 500, 32)).toBe('live')
    expect(state.verdict(1, 513, 1)).toBe('no-data')
    expect(state.verdict(1, 0, 1)).toBe('no-data')
  })

  it('treats a zero footprint as one channel rather than none', () => {
    const state = new DmxState()
    state.apply(frame({ slots: levels({ 7: 9 }) }), 1000)
    expect(state.verdict(1, 7, 0)).toBe('live')
  })
})

describe('sequence arithmetic', () => {
  it('measures the shorter way round the byte', () => {
    expect(signedByteDiff(1, 255)).toBe(2)
    expect(signedByteDiff(255, 1)).toBe(-2)
    expect(signedByteDiff(5, 5)).toBe(0)
    expect(signedByteDiff(5, 4)).toBe(1)
    expect(signedByteDiff(4, 5)).toBe(-1)
    expect(signedByteDiff(127, 0)).toBe(127)
    expect(signedByteDiff(128, 0)).toBe(-128)
  })
})

describe('frames going missing', () => {
  /** Send `count` frames from `start`, skipping the sequence numbers named. */
  const send = (
    state: DmxState,
    from: number,
    count: number,
    skip: number[] = [],
    startAt = 1000,
    gapMs = 33
  ): number => {
    let at = startAt
    for (let seq = from; seq < from + count; seq++) {
      if (!skip.includes(seq & 0xff)) state.apply(frame({ sequence: seq & 0xff }), at)
      at += gapMs
    }
    return at
  }

  it('reads sequence gaps as loss once a window completes', () => {
    const state = new DmxState()
    // ~330 frames over 11 s with 10 skipped: 10 missed of 330 sent ≈ 3%.
    // Skip values chosen so their +256 counterparts fall past frame 333 —
    // the sequence wraps, and a value under 78 would be skipped twice.
    const skipped = [100, 101, 102, 103, 104, 150, 151, 152, 153, 154]
    send(state, 1, 333, skipped)
    const [health] = state.health()
    const loss = health.sources[0].lossPct
    expect(loss).not.toBeNull()
    expect(loss!).toBeGreaterThan(0.02)
    expect(loss!).toBeLessThan(0.04)
  })

  it('reports zero loss for a clean stream, not null and not noise', () => {
    const state = new DmxState()
    send(state, 1, 333)
    expect(state.health()[0].sources[0].lossPct).toBe(0)
  })

  it('refunds a straggler the network reordered rather than lost', () => {
    const state = new DmxState()
    // 5 arrives late: skipped at its slot (counted missing), then delivered.
    const at = send(state, 1, 4) // 1..4
    state.apply(frame({ sequence: 6 }), at) // gap: 5 counted missing
    state.apply(frame({ sequence: 5 }), at + 5) // the straggler arrives
    send(state, 7, 320, [], at + 33)
    expect(state.health()[0].sources[0].lossPct).toBe(0)
  })

  it('reads a big forward jump as a source restart, not a massacre', () => {
    const state = new DmxState()
    const at = send(state, 1, 10)
    // The console rebooted and its sequence leapt. Counting the jump as loss
    // would report a healthy desk as losing half its frames for ten seconds.
    state.apply(frame({ sequence: 200 }), at)
    send(state, 201, 320, [], at + 33)
    expect(state.health()[0].sources[0].lossPct).toBe(0)
  })

  it('cannot say anything about an unsequenced source', () => {
    const state = new DmxState()
    for (let i = 0; i < 400; i++) {
      state.apply(
        frame({ protocol: 'artnet', sourceId: '2.0.0.7', sequence: 0, sequenced: false }),
        1000 + i * 33
      )
    }
    // Art-Net with sequencing disabled has no gaps to count. Null, not 0% —
    // 0% would be the panel inventing evidence.
    expect(state.health()[0].sources[0].lossPct).toBeNull()
  })

  it('recovers to the truth after a lossy spell ends', () => {
    const state = new DmxState()
    send(state, 1, 333, [100, 101, 102, 103, 104, 150, 151, 152, 153, 154])
    expect(state.health()[0].sources[0].lossPct).not.toBeNull()
    // The rig parks on a look: keep-alives once a second, all arriving. The
    // windows that follow are sparse but intact, so the loss figure walks
    // back to zero rather than freezing the bad number on the panel.
    let at = 20_000
    for (let seq = 100; seq < 130; seq++) {
      state.apply(frame({ sequence: seq & 0xff }), at)
      at += 900
    }
    expect(state.health()[0].sources[0].lossPct).toBe(0)
  })
})

describe('everything going dark at once', () => {
  const feed = (
    state: DmxState,
    universes: number[],
    protocol: 'sacn' | 'artnet',
    from: number,
    to: number
  ): void => {
    for (let at = from; at <= to; at += 500) {
      for (const u of universes) {
        state.apply(
          frame({
            protocol,
            wireUniverse: u,
            sourceId: protocol === 'sacn' ? `desk-${u}` : `2.0.0.${u}`,
            sequenced: false,
            sequence: 0,
          }),
          at
        )
      }
    }
  }

  it('correlates every sACN universe dying together into one outage', () => {
    const state = new DmxState({ artnetBase: 100 })
    feed(state, [1, 2, 3], 'sacn', 1000, 10_000)
    feed(state, [1], 'artnet', 1000, 10_000)
    state.sweep(10_000)
    expect(state.outages()).toHaveLength(0)

    // The multicast path dies at 10 s; Art-Net broadcast keeps arriving.
    feed(state, [1], 'artnet', 10_500, 14_000)
    state.sweep(11_000)
    state.sweep(12_000)
    state.sweep(13_000) // sACN's 2.5 s timeout has now passed for all three
    const [outage] = state.outages()
    expect(outage).toBeDefined()
    expect(outage.protocol).toBe('sacn')
    expect(outage.universes).toEqual([1, 2, 3])
    expect(outage.otherProtocolAlive).toBe(true)
  })

  it('does not blame the network while any universe survives', () => {
    const state = new DmxState()
    feed(state, [1, 2, 3], 'sacn', 1000, 10_000)
    // Universe 3's desk keeps talking; 1 and 2 stop.
    feed(state, [3], 'sacn', 10_000, 20_000)
    state.sweep(13_000)
    state.sweep(14_000)
    expect(state.outages()).toHaveLength(0)
  })

  it('needs at least two universes to implicate the path', () => {
    const state = new DmxState()
    feed(state, [1], 'sacn', 1000, 10_000)
    state.sweep(13_000)
    expect(state.outages()).toHaveLength(0)
  })

  it('clears the outage the moment data returns', () => {
    const state = new DmxState()
    feed(state, [1, 2], 'sacn', 1000, 10_000)
    state.sweep(13_000)
    expect(state.outages()).toHaveLength(1)
    feed(state, [1], 'sacn', 60_000, 60_500)
    expect(state.outages()).toHaveLength(0)
  })

  it('does not correlate silences that happened minutes apart', () => {
    const state = new DmxState()
    feed(state, [1], 'sacn', 1000, 10_000)
    feed(state, [2], 'sacn', 1000, 60_000)
    state.sweep(13_000) // universe 1 dies alone
    state.sweep(63_000) // universe 2 dies alone, 50 s later
    expect(state.outages()).toHaveLength(0)
  })
})

describe('the node inventory', () => {
  it('keeps every node that ever announced itself, with first and last seen', () => {
    const state = new DmxState()
    state.noteNode({ ip: '2.0.0.7', shortName: 'SL', longName: 'Stage Left' }, 1000)
    state.noteNode({ ip: '2.0.0.8', shortName: 'FOH', longName: '' }, 2000)
    state.noteNode({ ip: '2.0.0.7', shortName: 'SL', longName: 'Stage Left' }, 9000)
    const nodes = state.nodes()
    expect(nodes).toHaveLength(2)
    const sl = nodes.find((n) => n.ip === '2.0.0.7')!
    expect(sl.firstSeen).toBe(1000)
    expect(sl.lastSeen).toBe(9000)
    expect(sl.name).toBe('SL')
    expect(sl.longName).toBe('Stage Left')
  })

  it('records a nameless node — presence is the point, the name is a bonus', () => {
    const state = new DmxState()
    state.noteNode({ ip: '2.0.0.9', shortName: '', longName: '' }, 1000)
    expect(state.nodes()).toHaveLength(1)
    expect(state.nodes()[0].ip).toBe('2.0.0.9')
  })

  it('a vanished node stays listed — that is the news the inventory carries', () => {
    const state = new DmxState()
    state.noteNode({ ip: '2.0.0.7', shortName: 'SL', longName: '' }, 1000)
    state.sweep(600_000) // ten minutes of sweeps later
    expect(state.nodes()).toHaveLength(1)
    expect(state.nodes()[0].lastSeen).toBe(1000)
  })
})

describe('whether the levels are on stage', () => {
  /**
   * A console that keeps sending, with sequence numbers that advance.
   *
   * Needed because a source is dropped after its own data-loss timeout, and
   * these tests are about what happens to a rig whose *desk is fine* and
   * whose synchronisation has failed. Sweeping past both timeouts at once
   * tests something else entirely — and did, until this existed.
   */
  const keepSending = (state: DmxState, over: Partial<DmxFrame>, times: number[]) => {
    times.forEach((t, i) => state.apply(frame({ ...over, sequence: i + 1 }), t))
  }

  it('says nothing about a rig that is not synchronising', () => {
    const state = new DmxState()
    state.apply(frame(), 1000)
    expect(state.health()[0].sync).toBe('none')
    expect(state.health()[0].syncAddress).toBe(0)
  })

  it('will not call data held on a sync address alone', () => {
    // The easy mistake, and E1.31 §6.2.4.1 forbids it outright: a receiver
    // "must not attempt to synchronize any data on a Synchronization Address
    // until it has received its first E1.31 Synchronization Packet containing
    // that address". A source advertising an address is stating an intent,
    // not a fact about any receiver.
    const state = new DmxState()
    state.watchSyncUniverses([1, 7962])
    state.apply(frame({ syncAddress: 7962 }), 1000)
    expect(state.health()[0].sync).not.toBe('held')
  })

  it('holds once the synchronization stream is actually arriving', () => {
    const state = new DmxState()
    state.watchSyncUniverses([1, 7962])
    state.noteSacnSync(7962, 1000)
    state.apply(frame({ syncAddress: 7962 }), 1000)
    expect(state.health()[0].sync).toBe('held')
    expect(state.health()[0].syncAddress).toBe(7962)
  })

  it('calls the stage frozen when the sync stream dies and force-sync is clear', () => {
    // The fault this exists for. §11.1.2 stops a receiver synchronising after
    // E131_NETWORK_DATA_LOSS_TIMEOUT with no sync packet, and §6.2.6 says
    // what happens next when force-synchronization is 0: components "shall
    // not update with any new packets until synchronization resumes". The
    // desk carries on sending and the stage stops moving, and neither end can
    // see it from where it is standing.
    const state = new DmxState()
    state.watchSyncUniverses([1, 7962])
    state.noteSacnSync(7962, 1000)
    keepSending(state, { syncAddress: 7962, forceSync: false }, [1000, 2000, 3000])
    expect(state.health()[0].sync).toBe('held')

    state.sweep(3000)
    expect(state.health()[0].sync).toBe('held')

    // The desk is still sending — that is the whole point. Only the sync
    // stream has stopped, and 2.5 s past the last one is E1.31's own
    // deadline for giving up on it.
    keepSending(state, { syncAddress: 7962, forceSync: false }, [3500])
    state.sweep(3600)
    expect(state.health()[0].sync).toBe('frozen')
  })

  it('does not claim frozen when the source let receivers carry on', () => {
    const state = new DmxState()
    state.watchSyncUniverses([1, 7962])
    state.noteSacnSync(7962, 1000)
    keepSending(state, { syncAddress: 7962, forceSync: true }, [1000, 3500])
    state.sweep(3600)
    expect(state.health()[0].sync).toBe('lost')
  })

  it('admits it cannot see a sync universe it never joined', () => {
    // §6.3.3.1 sends synchronization packets only to their own universe's
    // multicast group. A box listening to 1-8 would never hear 7962's, so
    // reporting a fault would be crying wolf at a rig that is fine — and the
    // fix, adding 7962 to the list, is only obvious if we say which.
    const state = new DmxState()
    state.watchSyncUniverses([1, 2])
    keepSending(state, { syncAddress: 7962 }, [1000, 8500])
    state.sweep(9000)
    expect(state.health()[0].sync).toBe('unwatched')
    expect(state.health()[0].syncAddress).toBe(7962)
  })

  it('treats knowing nothing about joins as unwatched, not as a fault', () => {
    const state = new DmxState()
    keepSending(state, { syncAddress: 7962 }, [1000, 8500])
    state.sweep(9000)
    expect(state.health()[0].sync).toBe('unwatched')
  })

  it('recovers when the sync stream comes back', () => {
    const state = new DmxState()
    state.watchSyncUniverses([1, 7962])
    state.noteSacnSync(7962, 1000)
    keepSending(state, { syncAddress: 7962 }, [1000, 3900])
    state.sweep(4000)
    expect(state.health()[0].sync).toBe('frozen')
    state.noteSacnSync(7962, 4100)
    expect(state.health()[0].sync).toBe('held')
  })

  it('buffers every Art-Net universe once an ArtSync is seen', () => {
    // ArtSync carries no port address and is broadcast, so it is one fact
    // about the network rather than one per universe.
    const state = new DmxState({ artnetBase: 0 })
    state.apply(frame({ protocol: 'artnet', sourceId: '2.0.0.7', wireUniverse: 0 }), 1000)
    state.apply(frame({ protocol: 'artnet', sourceId: '2.0.0.7', wireUniverse: 1 }), 1000)
    expect(state.health().map((u) => u.sync)).toEqual(['none', 'none'])

    state.noteArtSync(1000)
    expect(state.health().map((u) => u.sync)).toEqual(['held', 'held'])
  })

  it('lets an Art-Net node revert to non-synchronous after four seconds', () => {
    // The Art-Net 4 specification's own figure. Holding "held" indefinitely
    // after a controller stops sending ArtSync would say a rig is waiting on
    // a cue that is never coming, when in fact it went back to outputting
    // normally.
    const state = new DmxState({ artnetBase: 0 })
    state.apply(frame({ protocol: 'artnet', sourceId: '2.0.0.7' }), 1000)
    state.noteArtSync(1000)

    state.sweep(4500)
    expect(state.health()[0].sync).toBe('held')
    state.sweep(5500)
    expect(state.health()[0].sync).toBe('none')
  })

  it('still records everLit for data that is being held', () => {
    // "Is the desk sending to these addresses" is a question about the desk
    // and the patch, and the answer is yes whether or not a receiver has been
    // told to take it. Gating the verdict on sync would report a correctly
    // patched, correctly synchronised rig as unpatched.
    const state = new DmxState()
    state.watchSyncUniverses([1, 7962])
    state.noteSacnSync(7962, 1000)
    state.apply(frame({ syncAddress: 7962, slots: levels({ 5: 128 }) }), 1000)
    expect(state.verdict(1, 5, 1)).toBe('live')
  })
  it('stops claiming a sync address once every source has gone', () => {
    // Otherwise a universe nobody is sending to keeps reporting itself frozen
    // on the last synchronisation the departed console asked for — a fault
    // attributed to a rig that is not there.
    const state = new DmxState()
    state.watchSyncUniverses([1, 7962])
    state.apply(frame({ syncAddress: 7962 }), 1000)
    state.sweep(9000)
    expect(state.health()[0].sources).toHaveLength(0)
    expect(state.health()[0].sync).toBe('none')
    expect(state.health()[0].syncAddress).toBe(0)
  })
})

describe('what the desks say they are sending', () => {
  const advert = (over: Partial<SacnDiscovery> = {}): SacnDiscovery => ({
    sourceId: 'desk-a',
    sourceName: 'grandMA3',
    page: 0,
    lastPage: 0,
    universes: [1, 2, 3],
    ...over,
  })

  it('records a single-page advertisement whole', () => {
    const state = new DmxState()
    state.noteDiscovery(advert(), 1000)
    const [found] = state.discovered()
    expect(found.universes).toEqual([1, 2, 3])
    expect(found.complete).toBe(true)
    expect(found.name).toBe('grandMA3')
  })

  it('joins pages that arrive out of order', () => {
    // §6.7.1.1 says pages "may be dropped or arrive out of order, potentially
    // even mixed in between different runs of pages", and leaves what to do
    // about it to the receiver.
    const state = new DmxState()
    state.noteDiscovery(advert({ page: 1, lastPage: 1, universes: [10, 11] }), 1000)
    state.noteDiscovery(advert({ page: 0, lastPage: 1, universes: [1, 2] }), 1010)
    const [found] = state.discovered()
    expect(found.universes).toEqual([1, 2, 10, 11])
    expect(found.complete).toBe(true)
  })

  it('reports a partial list as partial rather than as the whole truth', () => {
    // Waiting for a complete set would report nothing at all when one page
    // keeps getting lost; reporting the union silently would present half a
    // desk as all of it. So: the union, and say which it is.
    const state = new DmxState()
    state.noteDiscovery(advert({ page: 0, lastPage: 2, universes: [1, 2] }), 1000)
    state.noteDiscovery(advert({ page: 2, lastPage: 2, universes: [20] }), 1010)
    const [found] = state.discovered()
    expect(found.universes).toEqual([1, 2, 20])
    expect(found.complete).toBe(false)
    expect(found.pagesSeen).toBe(2)
    expect(found.pages).toBe(3)
  })

  it('lets a source drop a universe rather than advertising it forever', () => {
    const state = new DmxState()
    state.noteDiscovery(advert({ universes: [1, 2, 3] }), 1000)
    state.noteDiscovery(advert({ universes: [1, 2] }), 12_000)
    expect(state.discovered()[0].universes).toEqual([1, 2])
  })

  it('drops pages a shortened run no longer has', () => {
    // A desk unpatched from half its universes goes from two pages to one.
    // Keeping page 1 around would keep advertising universes it let go.
    const state = new DmxState()
    state.noteDiscovery(advert({ page: 0, lastPage: 1, universes: [1, 2] }), 1000)
    state.noteDiscovery(advert({ page: 1, lastPage: 1, universes: [10, 11] }), 1010)
    expect(state.discovered()[0].universes).toEqual([1, 2, 10, 11])

    state.noteDiscovery(advert({ page: 0, lastPage: 0, universes: [1, 2] }), 11_000)
    const [found] = state.discovered()
    expect(found.universes).toEqual([1, 2])
    expect(found.complete).toBe(true)
  })

  it('forgets a source two discovery intervals after it stops advertising', () => {
    // 20 s, because §12.2 lets a source that has stopped transmitting wait
    // until the second interval before saying so — anything shorter calls a
    // conforming desk stale while it is behaving exactly as specified.
    const state = new DmxState()
    state.noteDiscovery(advert(), 1000)
    state.sweep(19_000)
    expect(state.discovered()).toHaveLength(1)
    state.sweep(22_000)
    expect(state.discovered()).toHaveLength(0)
  })

  it('keeps sources apart by CID', () => {
    const state = new DmxState()
    state.noteDiscovery(advert({ sourceId: 'a', sourceName: 'Desk A', universes: [1] }), 1000)
    state.noteDiscovery(advert({ sourceId: 'b', sourceName: 'Desk B', universes: [9] }), 1000)
    expect(state.discovered().map((s) => s.name)).toEqual(['Desk A', 'Desk B'])
    expect(state.discovered().map((s) => s.universes)).toEqual([[1], [9]])
  })

  it('carries an empty advertisement without inventing universes', () => {
    const state = new DmxState()
    state.noteDiscovery(advert({ universes: [] }), 1000)
    expect(state.discovered()[0].universes).toEqual([])
    expect(state.discovered()[0].complete).toBe(true)
  })
})
