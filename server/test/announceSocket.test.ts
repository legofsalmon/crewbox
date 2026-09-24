import dgram from 'node:dgram'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  TYPE_A,
  TYPE_PTR,
  TYPE_SRV,
  decodeMessage,
  encodeMessage,
  type Message,
} from '../src/announce/dns.ts'
import { Announcer, MDNS_GROUP } from '../src/announce/responder.ts'

/**
 * The announcer on a real socket: loopback, a high port (5353 belongs to
 * every mDNS responder on the machine), and a phone played by a second
 * socket. What is under test is what a stood-in socket cannot show: that
 * the packets it writes survive a real network stack, and that a phone's
 * question gets a phone an answer.
 *
 * Multicast has to loop back for this, and some containers will not do it.
 * The platform is asked once, up front, the way the lighting listener's
 * tests ask (server/test/dmxListener.test.ts): if it can, a missing answer
 * is a failure; if it cannot, the group is skipped by name, and
 * CREWBOX_TEST_REQUIRE_MULTICAST=1 turns that skip into a failure.
 */

const PORT = 45_354
let multicastLoops = false

beforeAll(async () => {
  const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const tx = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  try {
    await new Promise<void>((resolve, reject) => {
      rx.once('error', reject)
      rx.bind(PORT + 1, resolve)
    })
    rx.addMembership(MDNS_GROUP, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      tx.once('error', reject)
      tx.bind(0, resolve)
    })
    tx.setMulticastLoopback(true)
    tx.setMulticastInterface('127.0.0.1')
    const heard = new Promise<boolean>((resolve) => {
      rx.once('message', () => resolve(true))
      setTimeout(() => resolve(false), 1500)
    })
    const beat = setInterval(() => tx.send(Buffer.from('probe'), PORT + 1, MDNS_GROUP), 50)
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
        'itself, so the announcer socket tests cannot run here.'
    )
  }
})

const open: Array<{ close: () => unknown }> = []

afterEach(async () => {
  for (const thing of open.splice(0).reverse()) {
    try {
      await thing.close()
    } catch {
      // Already closed.
    }
  }
})

const until = async (check: () => boolean, ms = 4000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return check()
}

const announcer = async (): Promise<Announcer> => {
  const a = new Announcer({
    address: '127.0.0.1',
    netmask: '255.0.0.0',
    port: 8787,
    mdnsPort: PORT,
    details: () => ({
      eventId: 'socket-test',
      eventName: 'Socket test',
      version: 'test',
      protocol: 1,
      setUp: true,
      tls: false,
    }),
  })
  open.push({ close: () => a.stop() })
  await a.start()
  return a
}

/** A phone: listening on the mDNS port and group, as a phone's responder does. */
const phone = async (port = PORT) => {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  open.push(socket)
  const heard: Message[] = []
  socket.on('message', (buf) => {
    const message = decodeMessage(buf)
    if (message?.response) heard.push(message)
  })
  await new Promise<void>((resolve) => socket.bind(port, resolve))
  if (port === PORT) socket.addMembership(MDNS_GROUP, '127.0.0.1')
  socket.setMulticastInterface('127.0.0.1')
  socket.setMulticastLoopback(true)
  return { socket, heard }
}

describe('on a real socket', () => {
  it('claims its name and announces it where a phone hears it', async (ctx) => {
    if (!multicastLoops) ctx.skip()
    const listening = await phone()
    const a = await announcer()
    expect(await until(() => a.state === 'announced')).toBe(true)
    expect(
      await until(() =>
        listening.heard.some((m) =>
          m.answers.some(
            (r) => r.type === TYPE_SRV && r.data.kind === 'srv' && r.data.port === 8787
          )
        )
      )
    ).toBe(true)
    // Its own announcements came back to it, and it did not take them for
    // somebody else's.
    expect(a.instanceName).toBe('Socket test')
  })

  it('answers a phone browsing for boxes', async (ctx) => {
    if (!multicastLoops) ctx.skip()
    const a = await announcer()
    expect(await until(() => a.state === 'announced')).toBe(true)
    // Past the second announcement and the second after it, in which the
    // same record may not be multicast again (RFC 6762 §6), so what arrives
    // is an answer.
    await new Promise((resolve) => setTimeout(resolve, 2200))
    const asking = await phone()
    const question = encodeMessage({
      id: 0,
      response: false,
      questions: [{ name: ['_crewbox', '_tcp', 'local'], type: TYPE_PTR, unicast: false }],
      answers: [],
      authorities: [],
      additionals: [],
    })
    asking.socket.send(question, PORT, MDNS_GROUP)
    expect(
      await until(() =>
        asking.heard.some(
          (m) =>
            m.answers.some((r) => r.type === TYPE_PTR) &&
            m.additionals.some(
              (r) => r.type === TYPE_A && r.data.kind === 'a' && r.data.address === '127.0.0.1'
            )
        )
      )
    ).toBe(true)
  }, 10_000)

  it('answers a one-shot question straight back to the port it came from', async (ctx) => {
    if (!multicastLoops) ctx.skip()
    const a = await announcer()
    expect(await until(() => a.state === 'announced')).toBe(true)
    const asking = await phone(0)
    const question = encodeMessage({
      id: 0x4242,
      response: false,
      questions: [{ name: [a.hostName, 'local'], type: TYPE_A, unicast: false }],
      answers: [],
      authorities: [],
      additionals: [],
    })
    asking.socket.send(question, PORT, MDNS_GROUP)
    expect(await until(() => asking.heard.some((m) => m.id === 0x4242))).toBe(true)
    const reply = asking.heard.find((m) => m.id === 0x4242)!
    expect(reply.questions[0]?.name).toEqual([a.hostName, 'local'])
    expect(reply.answers[0]?.ttl).toBeLessThanOrEqual(10)
  })

  it('says goodbye when it stops', async (ctx) => {
    if (!multicastLoops) ctx.skip()
    const listening = await phone()
    const a = await announcer()
    expect(await until(() => a.state === 'announced')).toBe(true)
    await a.stop()
    expect(
      await until(() =>
        listening.heard.some((m) => m.answers.length > 0 && m.answers.every((r) => r.ttl === 0))
      )
    ).toBe(true)
  })
})
