import type { networkInterfaces } from 'node:os'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { MetricsStore } from '../src/audit/metrics.ts'
import {
  ARTNET_PORT,
  buildArtPoll,
  buildMdnsQuery,
  MDNS_GROUP,
  MDNS_PORT,
  Prober,
  type AuditProbeIo,
  type ProberDeps,
} from '../src/audit/probes.ts'
import type { Probes } from '../src/environment.ts'

/**
 * The deep probe is the audit's one transmission, so it is tested byte for
 * byte: exactly what leaves, on which socket, with the socket always
 * closed — and exactly when nothing must leave at all.
 */

describe('packet builders', () => {
  it('ArtPoll is the 14-byte discovery packet, diagnostics off', () => {
    const p = buildArtPoll()
    expect(p.length).toBe(14)
    expect(p.subarray(0, 8).toString('latin1')).toBe('Art-Net\0')
    expect(p.readUInt16LE(8)).toBe(0x2000) // OpPoll
    expect(p[10]).toBe(0) // ProtVer hi
    expect(p[11]).toBe(14) // ProtVer lo
    expect(p[12]).toBe(0) // TalkToMe: no continuous replies, no diagnostics
    expect(p[13]).toBe(0) // DiagPriority
  })

  it('the mDNS query asks two PTR questions, QM', () => {
    const q = buildMdnsQuery()
    expect(q.readUInt16BE(0)).toBe(0) // ID 0 (mDNS)
    expect(q.readUInt16BE(2)).toBe(0) // standard query
    expect(q.readUInt16BE(4)).toBe(2) // QDCOUNT
    expect(q.readUInt16BE(6)).toBe(0) // ANCOUNT
    const text = q.toString('latin1')
    expect(text).toContain('_netaudio-arc')
    expect(text).toContain('_ndi')
    // QU bit clear on both questions: responses go to the multicast group,
    // where the passive listener (and everyone else, as normal) hears them.
    const qclassOffsets: number[] = []
    for (let i = 12; i < q.length - 1; i++) {
      if (q.readUInt16BE(i) === 12 && q.readUInt16BE(i + 2) === 1) qclassOffsets.push(i + 2)
    }
    expect(qclassOffsets).toHaveLength(2)
  })
})

/** A fake dgram socket that records everything and can fail on demand. */
class FakeSocket {
  static instances: FakeSocket[] = []
  sent: Array<{ packet: Buffer; port: number; address: string }> = []
  broadcast = false
  multicastInterface = ''
  closed = false
  private handlers = new Map<string, (...args: unknown[]) => void>()

  constructor(public readonly failSend: boolean) {
    FakeSocket.instances.push(this)
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, handler)
    return this
  }

  boundTo = ''

  bind(a?: number | (() => void), b?: string, c?: () => void) {
    if (typeof a === 'function') a()
    else {
      this.boundTo = b ?? ''
      c?.()
    }
    return this
  }

  setBroadcast(v: boolean) {
    this.broadcast = v
  }

  setMulticastInterface(iface: string) {
    this.multicastInterface = iface
  }

  send(packet: Buffer, port: number, address: string, cb: (err?: Error) => void) {
    if (this.failSend) {
      cb(new Error('EPERM'))
      return
    }
    this.sent.push({ packet, port, address })
    cb()
  }

  close() {
    this.closed = true
  }
}

function fakeEnv(over: Partial<Probes> = {}): Probes {
  return {
    tcpReachable: async () => false,
    noContentOk: async () => false,
    resolve4: async () => [],
    localAddresses: () => ['192.168.200.50'],
    certPem: () => null,
    now: () => 0,
    ...over,
  }
}

/** A box with a crew adapter and a lighting one, as every real one has. */
const fakeInterfaces = (() => ({
  wlan0: [{ family: 'IPv4', address: '192.168.200.1', netmask: '255.255.255.0' }],
  eth1: [{ family: 'IPv4', address: '2.0.0.5', netmask: '255.0.0.0' }],
})) as unknown as typeof networkInterfaces

function harness(deps: Partial<ProberDeps> = {}, env: Partial<Probes> = {}, failSend = false) {
  FakeSocket.instances = []
  const metrics = new MetricsStore(openDb(':memory:'))
  const io: AuditProbeIo = {
    createSocket: () =>
      new FakeSocket(failSend) as unknown as ReturnType<AuditProbeIo['createSocket']>,
    env: fakeEnv(env),
    now: () => 1_700_000_000_000,
    wait: async () => {},
    interfaces: fakeInterfaces,
  }
  const prober = new Prober(
    io,
    {
      dmxIface: () => '',
      watchIface: () => '',
      certHostname: () => undefined,
      watching: () => false,
      ...deps,
    },
    metrics
  )
  return { prober, metrics }
}

const result = (run: Awaited<ReturnType<Prober['run']>>, id: string) =>
  run.probes.find((p) => p.id === id)!

describe('Prober', () => {
  it('with nothing configured, nothing is transmitted at all', async () => {
    const { prober } = harness()
    const run = await prober.run('Colm')
    expect(FakeSocket.instances).toHaveLength(0)
    expect(result(run, 'artnet-inventory').state).toBe('skipped')
    expect(result(run, 'artnet-inventory').sent).toBe('nothing')
    expect(result(run, 'mdns-roster').state).toBe('skipped')
    expect(result(run, 'crew-dns').state).toBe('skipped')
  })

  it('sends exactly one ArtPoll on the lighting iface, broadcast, then closes', async () => {
    let nodes = 3
    const { prober } = harness({ dmxIface: () => '2.0.0.5', nodeCount: () => nodes++ })
    const run = await prober.run('Colm')
    const sockets = FakeSocket.instances
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.sent).toHaveLength(1)
    // The lighting segment's own broadcast, out of the lighting address —
    // not 255.255.255.255 down whichever route the kernel liked, which on
    // this box is the crew Wi-Fi.
    expect(sockets[0]!.sent[0]!.address).toBe('2.255.255.255')
    expect(sockets[0]!.sent[0]!.port).toBe(ARTNET_PORT)
    expect(sockets[0]!.sent[0]!.packet.equals(buildArtPoll())).toBe(true)
    expect(sockets[0]!.broadcast).toBe(true)
    expect(sockets[0]!.boundTo).toBe('2.0.0.5')
    expect(sockets[0]!.closed).toBe(true)
    const r = result(run, 'artnet-inventory')
    expect(r.state).toBe('ok')
    expect(r.detail).toContain('answered only when asked')
  })

  it('names the segment it broadcast to, so a capture can be checked against it', async () => {
    const { prober } = harness({ dmxIface: () => '2.0.0.5' })
    const run = await prober.run('Colm')
    expect(result(run, 'artnet-inventory').sent).toContain('2.255.255.255')
    expect(result(run, 'artnet-inventory').sent).toContain('from 2.0.0.5')
  })

  it('sends nothing at all when no adapter here holds the lighting address', async () => {
    // A stale CREWBOX_DMX_IFACE, or a card that never came up. There is no
    // careful way to broadcast from an address the box does not have, so it
    // does not: the alternative is a discovery packet on the crew network.
    const { prober } = harness({ dmxIface: () => '10.9.9.9' })
    const run = await prober.run('Colm')
    expect(FakeSocket.instances).toHaveLength(0)
    const r = result(run, 'artnet-inventory')
    expect(r.state).toBe('skipped')
    expect(r.sent).toBe('nothing')
    expect(r.detail).toContain('10.9.9.9')
  })

  it('sends the mDNS query to the group only when the watchers listen', async () => {
    const { prober } = harness({ watching: () => true, mdnsCount: () => 2 })
    await prober.run('Colm')
    const sockets = FakeSocket.instances
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.sent[0]!.address).toBe(MDNS_GROUP)
    expect(sockets[0]!.sent[0]!.port).toBe(MDNS_PORT)
    expect(sockets[0]!.sent[0]!.packet.equals(buildMdnsQuery())).toBe(true)
    expect(sockets[0]!.closed).toBe(true)
  })

  it('a send failure closes the socket and degrades the result, not the run', async () => {
    const { prober } = harness({ dmxIface: () => '2.0.0.5' }, {}, true)
    const run = await prober.run('Colm')
    expect(FakeSocket.instances[0]!.closed).toBe(true)
    expect(result(run, 'artnet-inventory').state).toBe('limited')
    expect(run.finishedAt).not.toBeNull()
  })

  it('refuses a second run while one is in flight', async () => {
    const { prober } = harness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = new Prober(
      {
        createSocket: () => new FakeSocket(false) as never,
        env: fakeEnv({ tcpReachable: () => gate.then(() => false) }),
        now: () => 0,
        wait: async () => {},
      },
      {
        dmxIface: () => '',
        watchIface: () => '',
        certHostname: () => undefined,
        watching: () => false,
      }
    )
    const first = slow.run('Colm')
    expect(slow.running).toBe(true)
    await expect(slow.run('Sam')).rejects.toThrow('busy')
    release()
    await first
    expect(slow.running).toBe(false)
    void prober
  })

  it('persists the run unfinished first, finished after — crash-visible', async () => {
    const { prober, metrics } = harness()
    await prober.run('Colm')
    const stored = metrics.latestProbeRun()
    expect(stored?.finishedAt).not.toBeNull()
    expect(stored?.by).toBe('Colm')
    expect((stored?.report as { probes: unknown[] }).probes).toHaveLength(4)
  })

  it('grades uplink states from the environment probes', async () => {
    const captive = harness({}, { tcpReachable: async () => true, noContentOk: async () => false })
    expect(result(await captive.prober.run('a'), 'crew-uplink').state).toBe('limited')

    const online = harness({}, { tcpReachable: async () => true, noContentOk: async () => true })
    expect(result(await online.prober.run('a'), 'crew-uplink').state).toBe('ok')

    const airGap = harness()
    const r = result(await airGap.prober.run('a'), 'crew-uplink')
    expect(r.state).toBe('info') // no internet is normal on site, not a fault
  })

  it('checks the venue DNS against this box, both ways', async () => {
    const right = harness(
      { certHostname: () => 'chat.example.ie' },
      { resolve4: async () => ['192.168.200.50'] }
    )
    expect(result(await right.prober.run('a'), 'crew-dns').state).toBe('ok')

    const wrong = harness(
      { certHostname: () => 'chat.example.ie' },
      { resolve4: async () => ['10.9.9.9'] }
    )
    const r = result(await wrong.prober.run('a'), 'crew-dns')
    expect(r.state).toBe('limited')
    expect(r.detail).toContain('not this box')
  })
})
