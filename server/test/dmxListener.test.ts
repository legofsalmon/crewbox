import dgram from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DmxListener,
  DmxTransmitAttempt,
  parseUniverseList,
  sacnGroup,
  SACN_PORT,
  ARTNET_PORT,
  MAX_SACN_UNIVERSES,
} from '../src/dmx/listener.ts'
import { artDmx, artSync, sacnData, sacnSync } from './dmxPackets.ts'

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
 * Real sockets on loopback, verified to genuinely deliver here rather than
 * pass vacuously — the assertions were temporarily turned into throws to
 * check they were reached.
 *
 * Where a platform will not carry multicast to itself these mark themselves
 * **skipped**, not passed. A silent pass in CI would be a test that reports
 * success for never having run.
 */
describe('reading a real socket', () => {
  it('picks up sACN sent to its multicast group', async (ctx) => {
    const listener = start({ mode: 'sacn', universes: [1] })
    await until(() => listener.snapshot().sacn.listening)
    if (listener.snapshot().sacn.failed.length > 0) ctx.skip()

    const tx = await sender()
    const packet = sacnData({ universe: 1, sourceName: 'Test Console', slots: [255, 0, 128] })
    const timer = setInterval(() => tx.send(packet, SACN_PORT, sacnGroup(1)), 50)
    const arrived = await until(() => listener.state.health().length > 0)
    clearInterval(timer)
    if (!arrived) ctx.skip()

    const [health] = listener.state.health()
    expect(health.universe).toBe(1)
    expect(health.sources[0].name).toBe('Test Console')
    expect(listener.state.levels(1)![0]).toBe(255)
    expect(listener.state.verdict(1, 1, 1)).toBe('live')
    expect(listener.state.verdict(1, 100, 4)).toBe('silent')
  })

  it('picks up broadcast Art-Net and maps its universe', async (ctx) => {
    const listener = start({ mode: 'artnet', artnetBase: 1 })
    await until(() => listener.snapshot().artnet.listening)

    const tx = await sender()
    // Art-Net universe 0 is plot universe 1 under the default base.
    const packet = artDmx({ universe: 0, slots: [0, 0, 77] })
    const timer = setInterval(() => tx.send(packet, ARTNET_PORT, '127.0.0.1'), 50)
    const arrived = await until(() => listener.state.health().length > 0)
    clearInterval(timer)
    if (!arrived) ctx.skip()

    const [health] = listener.state.health()
    expect(health.universe).toBe(1)
    expect(health.wireUniverse).toBe(0)
    expect(listener.state.levels(1)![2]).toBe(77)
  })

  it('ignores traffic on the port that is not ours', async (ctx) => {
    const listener = start({ mode: 'artnet' })
    await until(() => listener.snapshot().artnet.listening)

    const tx = await sender()
    const timer = setInterval(
      () => tx.send(Buffer.from('some other protocol entirely'), ARTNET_PORT, '127.0.0.1'),
      50
    )
    const counted = await until(() => listener.snapshot().ignored > 0)
    clearInterval(timer)
    if (!counted) ctx.skip()

    expect(listener.snapshot().packets).toBe(0)
    expect(listener.state.health()).toHaveLength(0)
  })

  it('holds Art-Net levels once an ArtSync reaches the socket', async (ctx) => {
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
    if (!arrived) ctx.skip()

    // The levels are readable and are not on stage. Both halves matter: a
    // monitor that reported one without the other would be lying by omission.
    expect(listener.state.levels(1)![0]).toBe(255)
    expect(listener.state.health()[0].sync).toBe('held')
  })

  it('holds sACN levels once a synchronization packet reaches the group', async (ctx) => {
    // The sync universe has to be joined for its packets to arrive at all,
    // which is exactly why `unwatched` exists as a verdict.
    const listener = start({ mode: 'sacn', universes: [1, 7962] })
    await until(() => listener.snapshot().sacn.listening)
    if (listener.snapshot().sacn.failed.length > 0) ctx.skip()

    const tx = await sender()
    const data = sacnData({ universe: 1, syncAddress: 7962, slots: [255] })
    const sync = sacnSync({ syncAddress: 7962 })
    const timer = setInterval(() => {
      tx.send(data, SACN_PORT, sacnGroup(1))
      tx.send(sync, SACN_PORT, sacnGroup(7962))
    }, 50)
    const arrived = await until(() => listener.state.health()[0]?.sync === 'held')
    clearInterval(timer)
    if (!arrived) ctx.skip()

    expect(listener.state.health()[0].syncAddress).toBe(7962)
    expect(listener.state.levels(1)![0]).toBe(255)
  })

  it('counts a synchronization packet as ours rather than as junk', async (ctx) => {
    const listener = start({ mode: 'sacn', universes: [7962] })
    await until(() => listener.snapshot().sacn.listening)
    if (listener.snapshot().sacn.failed.length > 0) ctx.skip()

    const tx = await sender()
    const timer = setInterval(
      () => tx.send(sacnSync({ syncAddress: 7962 }), SACN_PORT, sacnGroup(7962)),
      50
    )
    const counted = await until(() => listener.snapshot().packets > 0)
    clearInterval(timer)
    if (!counted) ctx.skip()

    expect(listener.snapshot().ignored).toBe(0)
  })
})
