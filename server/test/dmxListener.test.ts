import dgram from 'node:dgram'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  DmxListener,
  DmxTransmitAttempt,
  parseUniverseList,
  sacnGroup,
  SACN_PORT,
  ARTNET_PORT,
  MAX_SACN_UNIVERSES,
} from '../src/dmx/listener.ts'
import { artDmx, artSync, sacnData, sacnDiscovery, sacnSync } from './dmxPackets.ts'

const listeners: DmxListener[] = []
const senders: dgram.Socket[] = []

afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop()
  for (const socket of senders.splice(0)) {
    try {
      socket.close()
    } catch {
      // Already closed.
    }
  }
})

const start = (options: Partial<ConstructorParameters<typeof DmxListener>[0]> = {}) => {
  const listener = new DmxListener({
    mode: 'both',
    universes: [1],
    artnetBase: 1,
    interfaceIp: '127.0.0.1',
    ...options,
  })
  listeners.push(listener)
  listener.start()
  return listener
}

/** A sender that exists only in this test. The product never has one. */
const sender = async (): Promise<dgram.Socket> => {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  senders.push(socket)
  await new Promise<void>((resolve) => socket.bind(0, resolve))
  socket.setMulticastTTL(1)
  socket.setMulticastLoopback(true)
  try {
    socket.setMulticastInterface('127.0.0.1')
  } catch {
    // Not fatal — the default interface may still deliver on loopback.
  }
  return socket
}

/** Poll until `check` passes or time runs out, so nothing races on a timer. */
const until = async (check: () => boolean, ms = 3000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return check()
}

describe('the read-only guarantee', () => {
  it('takes send() off every socket it opens', () => {
    // The rule at the top of docs/DMX_MONITORING.md is the kind that erodes
    // quietly. This is what keeps it true: a future change that tries to
    // answer an ArtPoll fails here rather than putting traffic on a rig.
    const opened: dgram.Socket[] = []
    start({
      createSocket: (options) => {
        const socket = dgram.createSocket(options)
        opened.push(socket)
        return socket
      },
    })
    expect(opened.length).toBeGreaterThan(0)
    for (const socket of opened) {
      expect(() => socket.send(Buffer.from('x'), 6454, '2.255.255.255')).toThrow(DmxTransmitAttempt)
    }
    for (const socket of opened) socket.close()
  })

  it('opens nothing at all when listening is off', () => {
    let created = 0
    const listener = new DmxListener({
      mode: 'off',
      universes: [1],
      artnetBase: 1,
      createSocket: (options) => {
        created++
        return dgram.createSocket(options)
      },
    })
    listeners.push(listener)
    listener.start()
    expect(created).toBe(0)
    expect(listener.snapshot().artnet.listening).toBe(false)
  })
})

describe('groups that would not join the first time', () => {
  /**
   * A socket whose `addMembership` refuses the named universes until the
   * returned handle is opened — an interface that was not up yet, which is
   * what a box powered on with the rest of the rack routinely meets.
   */
  const withCardDown = (refuse: number[]) => {
    const state = { down: true }
    const createSocket = (options: dgram.SocketOptions) => {
      const socket = dgram.createSocket(options)
      const real = socket.addMembership.bind(socket)
      socket.addMembership = (group: string, iface?: string) => {
        const universe = Number(group.split('.')[2]) * 256 + Number(group.split('.')[3])
        if (state.down && refuse.includes(universe)) {
          const err = new Error('addMembership EADDRNOTAVAIL') as Error & { code: string }
          err.code = 'ENODEV'
          throw err
        }
        real(group, iface)
      }
      return socket
    }
    return { createSocket, cableIn: () => (state.down = false) }
  }

  it('keeps trying, and joins when the interface comes up', async () => {
    const card = withCardDown([2])
    const listener = start({
      mode: 'sacn',
      universes: [1, 2],
      joinRetryMs: 0,
      createSocket: card.createSocket,
    })
    expect(await until(() => listener.snapshot().sacn.listening)).toBe(true)
    expect(listener.snapshot().sacn.joined).toEqual([1])
    expect(listener.snapshot().sacn.failed).toEqual([
      { universe: 2, reason: 'ENODEV', retrying: true },
    ])

    card.cableIn()
    expect(await until(() => listener.snapshot().sacn.joined.length === 2)).toBe(true)
    expect(listener.snapshot().sacn.joined).toEqual([1, 2])
    expect(listener.snapshot().sacn.failed).toEqual([])
  })

  it('does not keep trying a universe over its own limit', async () => {
    const listener = start({
      mode: 'sacn',
      universes: Array.from({ length: MAX_SACN_UNIVERSES + 2 }, (_, i) => i + 1),
      joinRetryMs: 0,
    })
    expect(await until(() => listener.snapshot().sacn.listening)).toBe(true)
    const failed = listener.snapshot().sacn.failed
    expect(failed.length).toBe(2)
    expect(failed.every((f) => !f.retrying)).toBe(true)
  })

  it('retries the discovery group too', async () => {
    // Without it there is no "here is what the desks are sending", which is
    // the one check that can tell a typo from a dead network.
    const card = withCardDown([64214])
    const listener = start({ mode: 'sacn', universes: [1], joinRetryMs: 0, ...card })
    expect(await until(() => listener.snapshot().sacn.listening)).toBe(true)
    expect(listener.snapshot().sacn.discovery).toBe(false)

    card.cableIn()
    expect(await until(() => listener.snapshot().sacn.discovery)).toBe(true)
  })
})

describe('universe lists', () => {
  it('expands ranges and single numbers', () => {
    expect(parseUniverseList('1-4,10')).toEqual([1, 2, 3, 4, 10])
    expect(parseUniverseList('7')).toEqual([7])
  })

  it('skips junk instead of failing to start', () => {
    expect(parseUniverseList('1, banana, 3')).toEqual([1, 3])
    expect(parseUniverseList('')).toEqual([])
  })

  it('drops universes outside the legal range', () => {
    expect(parseUniverseList('0,1,70000')).toEqual([1])
  })

  it('maps a universe to its multicast group', () => {
    expect(sacnGroup(1)).toBe('239.255.0.1')
    expect(sacnGroup(256)).toBe('239.255.1.0')
    expect(sacnGroup(63999)).toBe('239.255.249.255')
  })
})

describe('joining groups', () => {
  it('refuses to join more than the platform will allow', async () => {
    // Linux gives 20 per socket and fails the rest silently. Being told which
    // universes were dropped beats a universe that mysteriously never arrives.
    const many = Array.from({ length: MAX_SACN_UNIVERSES + 4 }, (_, i) => i + 1)
    const listener = start({ mode: 'sacn', universes: many })
    await until(() => listener.snapshot().sacn.listening)
    const { joined, failed } = listener.snapshot().sacn
    expect(joined).toHaveLength(MAX_SACN_UNIVERSES)
    expect(failed).toHaveLength(4)
    expect(failed[0].reason).toContain('limit')
  })
})

/**
 * Can this machine carry multicast to itself at all?
 *
 * Asked once, with plain sockets, before any of the tests below run — and
 * deliberately without the product in it, so the answer is about the
 * platform rather than about the code under test.
 *
 * The tests used to ask a different question. Each one sent packets, waited,
 * and called `ctx.skip()` when none arrived — so a receive path that had
 * genuinely broken skipped itself, and the suite reported green. Every
 * regression in the one code path that reads a lighting network would have
 * looked exactly like a container that does not do multicast.
 *
 * Now the platform decides once, up front. If it can loop multicast back,
 * a packet that does not arrive is a failure and says so. If it cannot,
 * the whole group is skipped by name rather than test by test — and
 * `CREWBOX_TEST_REQUIRE_MULTICAST=1` turns that skip into a failure, so CI
 * can insist these actually ran.
 */
const PROBE_GROUP = sacnGroup(60000)
let multicastLoops = false

beforeAll(async () => {
  const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const tx = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  try {
    // 0.0.0.0, the way the listener binds: on Linux, binding a multicast
    // socket to a unicast address receives nothing at all.
    await new Promise<void>((resolve, reject) => {
      rx.once('error', reject)
      rx.bind(SACN_PORT, resolve)
    })
    try {
      rx.addMembership(PROBE_GROUP, '127.0.0.1')
    } catch {
      rx.addMembership(PROBE_GROUP)
    }
    await new Promise<void>((resolve, reject) => {
      tx.once('error', reject)
      tx.bind(0, resolve)
    })
    tx.setMulticastTTL(1)
    tx.setMulticastLoopback(true)
    try {
      tx.setMulticastInterface('127.0.0.1')
    } catch {
      // The default interface may still deliver.
    }
    const heard = new Promise<boolean>((resolve) => {
      rx.once('message', () => resolve(true))
      setTimeout(() => resolve(false), 1500)
    })
    const beat = setInterval(() => tx.send(Buffer.from('probe'), SACN_PORT, PROBE_GROUP), 50)
    multicastLoops = await heard
    clearInterval(beat)
  } catch {
    multicastLoops = false
  } finally {
    for (const socket of [rx, tx]) {
      try {
        socket.close()
      } catch {
        // Never opened, or already closed.
      }
    }
  }
  if (!multicastLoops && process.env.CREWBOX_TEST_REQUIRE_MULTICAST === '1') {
    throw new Error(
      'CREWBOX_TEST_REQUIRE_MULTICAST=1, but this machine will not loop multicast back to ' +
        'itself, so the sACN receive tests cannot run here.'
    )
  }
})

/**
 * Real sockets on loopback, verified to genuinely deliver here rather than
 * pass vacuously — the assertions were temporarily turned into throws to
 * check they were reached.
 */
describe('reading a real socket', () => {
  it('picks up sACN sent to its multicast group', async (ctx) => {
    if (!multicastLoops) ctx.skip()
    const listener = start({ mode: 'sacn', universes: [1] })
    await until(() => listener.snapshot().sacn.listening)
    expect(listener.snapshot().sacn.failed).toEqual([])

    const tx = await sender()
    const packet = sacnData({ universe: 1, sourceName: 'Test Console', slots: [255, 0, 128] })
    const timer = setInterval(() => tx.send(packet, SACN_PORT, sacnGroup(1)), 50)
    const arrived = await until(() => listener.state.health().length > 0)
    clearInterval(timer)
    expect(arrived).toBe(true)

    const [health] = listener.state.health()
    expect(health.universe).toBe(1)
    expect(health.sources[0].name).toBe('Test Console')
    expect(listener.state.levels(1)![0]).toBe(255)
    expect(listener.state.verdict(1, 1, 1)).toBe('live')
    expect(listener.state.verdict(1, 100, 4)).toBe('silent')
  })

  it('picks up broadcast Art-Net and maps its universe', async () => {
    const listener = start({ mode: 'artnet', artnetBase: 1 })
    await until(() => listener.snapshot().artnet.listening)

    const tx = await sender()
    // Art-Net universe 0 is plot universe 1 under the default base.
    const packet = artDmx({ universe: 0, slots: [0, 0, 77] })
    const timer = setInterval(() => tx.send(packet, ARTNET_PORT, '127.0.0.1'), 50)
    const arrived = await until(() => listener.state.health().length > 0)
    clearInterval(timer)
    // Plain unicast to 127.0.0.1, which every platform delivers — so a
    // packet that does not arrive here is this listener's fault, not the
    // machine's, and used to skip itself out of the report.
    expect(arrived).toBe(true)

    const [health] = listener.state.health()
    expect(health.universe).toBe(1)
    expect(health.wireUniverse).toBe(0)
    expect(listener.state.levels(1)![2]).toBe(77)
  })

  it('ignores traffic on the port that is not ours', async () => {
    const listener = start({ mode: 'artnet' })
    await until(() => listener.snapshot().artnet.listening)

    const tx = await sender()
    const timer = setInterval(
      () => tx.send(Buffer.from('some other protocol entirely'), ARTNET_PORT, '127.0.0.1'),
      50
    )
    const counted = await until(() => listener.snapshot().ignored > 0)
    clearInterval(timer)
    expect(counted).toBe(true)

    expect(listener.snapshot().packets).toBe(0)
    expect(listener.state.health()).toHaveLength(0)
  })

  it('holds Art-Net levels once an ArtSync reaches the socket', async () => {
    const listener = start({ mode: 'artnet', artnetBase: 1 })
    await until(() => listener.snapshot().artnet.listening)

    const tx = await sender()
    const dmx = artDmx({ universe: 0, slots: [255] })
    const timer = setInterval(() => {
      tx.send(dmx, ARTNET_PORT, '127.0.0.1')
      tx.send(artSync(), ARTNET_PORT, '127.0.0.1')
    }, 50)
    const arrived = await until(() => listener.state.health()[0]?.sync === 'held')
    clearInterval(timer)
    expect(arrived).toBe(true)

    // The levels are readable and are not on stage. Both halves matter: a
    // monitor that reported one without the other would be lying by omission.
    expect(listener.state.levels(1)![0]).toBe(255)
    expect(listener.state.health()[0].sync).toBe('held')
  })

  it('holds sACN levels once a synchronization packet reaches the group', async (ctx) => {
    if (!multicastLoops) ctx.skip()
    // The sync universe has to be joined for its packets to arrive at all,
    // which is exactly why `unwatched` exists as a verdict.
    const listener = start({ mode: 'sacn', universes: [1, 7962] })
    await until(() => listener.snapshot().sacn.listening)
    expect(listener.snapshot().sacn.failed).toEqual([])

    const tx = await sender()
    const data = sacnData({ universe: 1, syncAddress: 7962, slots: [255] })
    const sync = sacnSync({ syncAddress: 7962 })
    const timer = setInterval(() => {
      tx.send(data, SACN_PORT, sacnGroup(1))
      tx.send(sync, SACN_PORT, sacnGroup(7962))
    }, 50)
    const arrived = await until(() => listener.state.health()[0]?.sync === 'held')
    clearInterval(timer)
    expect(arrived).toBe(true)

    expect(listener.state.health()[0].syncAddress).toBe(7962)
    expect(listener.state.levels(1)![0]).toBe(255)
  })

  it('counts a synchronization packet as ours rather than as junk', async (ctx) => {
    if (!multicastLoops) ctx.skip()
    const listener = start({ mode: 'sacn', universes: [7962] })
    await until(() => listener.snapshot().sacn.listening)
    expect(listener.snapshot().sacn.failed).toEqual([])

    const tx = await sender()
    const timer = setInterval(
      () => tx.send(sacnSync({ syncAddress: 7962 }), SACN_PORT, sacnGroup(7962)),
      50
    )
    const counted = await until(() => listener.snapshot().packets > 0)
    clearInterval(timer)
    expect(counted).toBe(true)

    expect(listener.snapshot().ignored).toBe(0)
  })

  it('hears a desk advertise itself on the discovery universe', async (ctx) => {
    if (!multicastLoops) ctx.skip()
    // The box joins 64214 whether or not anybody listed it, because E1.31 §12
    // says discovery exists so a monitor does not have to join every group to
    // find out what is out there — and this box is that monitor.
    const listener = start({ mode: 'sacn', universes: [1] })
    await until(() => listener.snapshot().sacn.listening)
    expect(await until(() => listener.snapshot().sacn.discovery)).toBe(true)

    const tx = await sender()
    const packet = sacnDiscovery({ universes: [1, 2, 3, 8], sourceName: 'Main Stage MA3' })
    const timer = setInterval(() => tx.send(packet, SACN_PORT, sacnGroup(64214), () => {}), 50)
    const arrived = await until(() => listener.state.discovered().length > 0)
    clearInterval(timer)
    expect(arrived).toBe(true)

    const [found] = listener.state.discovered()
    expect(found.name).toBe('Main Stage MA3')
    expect(found.universes).toEqual([1, 2, 3, 8])
    expect(found.complete).toBe(true)
    // And it did not have to be listening to 2, 3 or 8 to learn any of that.
    expect(listener.snapshot().sacn.joined).toEqual([1])
  })
})
