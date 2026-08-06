import dgram from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { DmxTransmitAttempt } from '../src/dmx/listener.ts'
import { NetWatch } from '../src/netwatch/listener.ts'

/**
 * Real sockets on loopback, high ports (319/320 are privileged and 5353 is
 * contended by every mDNS responder). What is under test: the read-only
 * guarantee, and that each protocol's packets land in the right state.
 */

const PORTS = { ptpEvent: 40_319, ptpGeneral: 40_320, mdns: 45_353, sap: 49_875 }

const watchers: NetWatch[] = []
const senders: dgram.Socket[] = []

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop()
  for (const socket of senders.splice(0)) {
    try {
      socket.close()
    } catch {
      // Already closed.
    }
  }
})

const start = (): NetWatch => {
  const watcher = new NetWatch({ interfaceIp: '127.0.0.1', ports: PORTS })
  watchers.push(watcher)
  watcher.start()
  return watcher
}

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

const until = async (check: () => boolean, ms = 3000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return check()
}

/** A minimal PTPv2 Announce naming `id` as grandmaster. */
const announce = (): Buffer => {
  const buf = Buffer.alloc(64)
  buf[0] = 0x0b
  buf[1] = 0x02
  buf.writeUInt16BE(64, 2)
  buf[47] = 128
  buf[48] = 248
  Buffer.from([0, 0x1d, 0xc1, 0xff, 0xfe, 1, 2, 3]).copy(buf, 53)
  return buf
}

/** A minimal SAP announcement with inline SDP. */
const sap = (): Buffer => {
  const header = Buffer.alloc(8)
  header[0] = 0x20
  header.writeUInt16BE(7, 2)
  return Buffer.concat([
    header,
    Buffer.from('application/sdp\0', 'latin1'),
    Buffer.from('v=0\r\no=- 1 1 IN IP4 10.0.0.7\r\ns=Test Stream\r\nc=IN IP4 239.69.0.1/32\r\n'),
  ])
}

describe('the media-network watchers', () => {
  it('take send() off every socket — the same promise as the DMX listener', () => {
    const watcher = start()
    // Reach the sockets through the same door a future feature would.
    const sockets = (watcher as unknown as { sockets: dgram.Socket[] }).sockets
    expect(sockets.length).toBe(4)
    for (const socket of sockets) {
      expect(() => socket.send(Buffer.from('x'), 40_000, '127.0.0.1')).toThrow(DmxTransmitAttempt)
    }
  })

  it('routes each protocol to its own state', async () => {
    const watcher = start()
    await until(() => watcher.snapshot().sap.listening)

    const from = await sender()
    from.send(announce(), PORTS.ptpGeneral, '224.0.1.129')
    from.send(sap(), PORTS.sap, '239.255.255.255')

    expect(
      await until(
        () =>
          watcher.ptp.status(Date.now()).grandmasterId === '00:1d:c1:ff:fe:01:02:03' &&
          watcher.sap.roster().length === 1
      )
    ).toBe(true)
    expect(watcher.sap.roster()[0]!.name).toBe('Test Stream')
    expect(watcher.snapshot().ptp.packets).toBeGreaterThan(0)
  })

  it('forgets everything on stop', async () => {
    const watcher = start()
    await until(() => watcher.snapshot().ptp.listening)
    const from = await sender()
    from.send(announce(), PORTS.ptpGeneral, '224.0.1.129')
    await until(() => watcher.ptp.status(Date.now()).grandmasterId !== null)
    watcher.stop()
    expect(watcher.ptp.status(Date.now()).grandmasterId).toBeNull()
    expect(watcher.snapshot().ptp.listening).toBe(false)
  })
})
