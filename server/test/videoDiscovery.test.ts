import { EventEmitter } from 'node:events'
import type dgram from 'node:dgram'
import { describe, expect, it } from 'vitest'
import {
  DISCOVERY_GROUP,
  PROBE,
  REPLY_PREFIX,
  broadcastFor,
  scan,
  subnetBroadcast,
  type ScanIo,
} from '../src/video/discovery.ts'

/**
 * The scan: the module's one transmission that is not a read of a named
 * device, and the only thing here that needs an admin to confirm it twice.
 *
 * What these tests pin is mostly restraint — that the probe is the eight
 * documented bytes and nothing else, that it goes to the segment somebody
 * pointed at rather than every interface the box holds, and that the reply
 * payload is *not* decoded into model and name. That last one is a real
 * correction: novasun described the reply as carrying model and name, then
 * withdrew it as an inference nobody had observed. Building on the withdrawn
 * version would have put invented labels on a screen.
 */

class FakeSocket extends EventEmitter {
  sent: Array<{ payload: Buffer; port: number; address: string }> = []
  broadcast = false
  bound: { port: number; address?: string } | null = null
  closed = false

  bind(port: number, address?: string | (() => void), cb?: () => void): void {
    const done = typeof address === 'function' ? address : cb
    this.bound = { port, ...(typeof address === 'string' ? { address } : {}) }
    done?.()
  }
  setBroadcast(on: boolean): void {
    this.broadcast = on
  }
  send(payload: Buffer, port: number, address: string, cb?: (err: Error | null) => void): void {
    this.sent.push({ payload, port, address })
    cb?.(null)
  }
  close(): void {
    this.closed = true
  }
}

const INTERFACES = () =>
  ({
    eth0: [
      {
        family: 'IPv4',
        address: '10.0.30.9',
        netmask: '255.255.255.0',
        internal: false,
        mac: '',
        cidr: null,
      },
    ],
    lo: [
      {
        family: 'IPv4',
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        internal: true,
        mac: '',
        cidr: null,
      },
    ],
  }) as unknown as ReturnType<ScanIo['interfaces']>

/**
 * `replies` arrive during the listen window, which is where a real one would
 * arrive — `wait` is the only point in a scan at which the socket is open,
 * the probe is out, and nothing else is happening.
 */
function fakeIo(socket: FakeSocket, replies: Array<{ from: string; buf: Buffer }> = []): ScanIo {
  return {
    createSocket: () => socket as unknown as dgram.Socket,
    wait: () => {
      for (const reply of replies)
        socket.emit('message', reply.buf, { address: reply.from, port: 3800 })
      return Promise.resolve()
    },
    interfaces: INTERFACES,
  }
}

describe('addressing', () => {
  it('computes the directed broadcast for a /24', () => {
    expect(subnetBroadcast('10.0.30.9', '255.255.255.0')).toBe('10.0.30.255')
  })

  it('handles a /22, which festival video networks actually use', () => {
    expect(subnetBroadcast('10.0.28.9', '255.255.252.0')).toBe('10.0.31.255')
  })

  it('refuses anything that is not a dotted quad', () => {
    expect(subnetBroadcast('processor.local', '255.255.255.0')).toBeNull()
    expect(subnetBroadcast('10.0.30.9', '/24')).toBeNull()
  })

  it('only answers for an address the box actually holds', () => {
    const io = fakeIo(new FakeSocket())
    expect(broadcastFor('10.0.30.9', io)).toBe('10.0.30.255')
    expect(broadcastFor('192.168.1.5', io)).toBeNull()
  })
})

describe('scanning', () => {
  it('sends the eight documented bytes, and only those', async () => {
    const socket = new FakeSocket()
    await scan('10.0.30.9', fakeIo(socket))
    expect(socket.sent).toHaveLength(2)
    for (const packet of socket.sent) {
      expect(packet.payload.equals(PROBE)).toBe(true)
      expect(packet.payload).toHaveLength(8)
      expect(packet.port).toBe(3800)
    }
  })

  it('goes to the chosen segment and the multicast group, not 255.255.255.255', async () => {
    // A limited broadcast leaves by whichever interface the routing table
    // fancies, which on a box that also holds the crew Wi-Fi means probing a
    // network nobody asked about.
    const socket = new FakeSocket()
    await scan('10.0.30.9', fakeIo(socket))
    expect(socket.sent.map((s) => s.address)).toEqual(['10.0.30.255', DISCOVERY_GROUP])
  })

  it('refuses an interface the box does not hold, without opening a socket', async () => {
    const socket = new FakeSocket()
    const result = await scan('192.168.1.5', fakeIo(socket))
    expect(result.errors[0]).toContain('not an address this box holds')
    expect(socket.sent).toHaveLength(0)
    expect(socket.bound).toBeNull()
  })

  it('identifies a processor by the reply source address', async () => {
    const io = fakeIo(new FakeSocket(), [{ from: '10.0.30.11', buf: REPLY_PREFIX }])
    expect((await scan('10.0.30.9', io)).found).toEqual([{ host: '10.0.30.11' }])
  })

  it('keeps the reply tail as an unlabelled string, never as model and name', async () => {
    // The claim that this payload carries model and name was an inference,
    // and it has been withdrawn. Until somebody captures a real reply the
    // bytes get shown as-is or not at all: a wrong label on a screen at 2am
    // is worse than a blank one.
    const io = fakeIo(new FakeSocket(), [
      {
        from: '10.0.30.11',
        buf: Buffer.concat([REPLY_PREFIX, Buffer.from('\x00MX40 Pro\x00wall')]),
      },
    ])
    const [found] = (await scan('10.0.30.9', io)).found
    expect(found.payload).toBe('MX40 Pro wall')
    expect(found).not.toHaveProperty('model')
    expect(found).not.toHaveProperty('name')
  })

  it('ignores traffic that is not a NovaStar reply', async () => {
    const io = fakeIo(new FakeSocket(), [
      { from: '10.0.30.50', buf: Buffer.from('HTTP/1.1 200 OK') },
      // Another control application's probe, not a controller's answer.
      { from: '10.0.30.60', buf: PROBE },
    ])
    expect((await scan('10.0.30.9', io)).found).toEqual([])
  })

  it('de-duplicates a processor that answers both the broadcast and the group', async () => {
    const io = fakeIo(new FakeSocket(), [
      { from: '10.0.30.11', buf: REPLY_PREFIX },
      { from: '10.0.30.11', buf: REPLY_PREFIX },
    ])
    expect((await scan('10.0.30.9', io)).found).toHaveLength(1)
  })

  it('reports what it transmitted, in words somebody can check against a capture', async () => {
    const result = await scan('10.0.30.9', fakeIo(new FakeSocket()))
    expect(result.sent).toEqual([
      '8 bytes "rqProMI:" to 10.0.30.255:3800 (UDP)',
      '8 bytes "rqProMI:" to 224.224.125.119:3800 (UDP)',
    ])
  })

  it('closes its socket, so nothing is held open between scans', async () => {
    const socket = new FakeSocket()
    await scan('10.0.30.9', fakeIo(socket))
    expect(socket.closed).toBe(true)
  })
})
