import { EventEmitter } from 'node:events'
import type dgram from 'node:dgram'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TYPE_A,
  TYPE_AAAA,
  TYPE_ANY,
  TYPE_NSEC,
  TYPE_PTR,
  TYPE_SRV,
  TYPE_TXT,
  decodeMessage,
  encodeMessage,
  type Message,
  type Name,
  type ResourceRecord,
} from '../src/announce/dns.ts'
import { Announcer, type ServiceDetails } from '../src/announce/responder.ts'

/**
 * The box's multicast DNS responder, against a stood-in socket and a fake
 * clock, so every timing RFC 6762 sets can be checked to the millisecond.
 * What it must get right: claim a name before using it, never take one
 * another device holds, answer phones on the crew network and nobody else,
 * and say goodbye.
 */

interface Sent {
  message: Message
  port: number
  address: string
}

class FakeSocket extends EventEmitter {
  sent: Sent[] = []
  bound: number | null = null
  memberships: Array<[string, string | undefined]> = []
  multicastInterface: string | null = null
  multicastTTL: number | null = null
  ttl: number | null = null
  closed = false
  bindError: Error | null = null

  bind(port: number, cb: () => void): void {
    queueMicrotask(() => {
      if (this.bindError) this.emit('error', this.bindError)
      else {
        this.bound = port
        cb()
      }
    })
  }
  addMembership(group: string, iface?: string): void {
    this.memberships.push([group, iface])
  }
  setMulticastInterface(iface: string): void {
    this.multicastInterface = iface
  }
  setMulticastTTL(ttl: number): void {
    this.multicastTTL = ttl
  }
  setTTL(ttl: number): void {
    this.ttl = ttl
  }
  setMulticastLoopback(): void {}
  /** A network stack that never says the packet went. */
  holdSends = false
  send(buf: Buffer, port: number, address: string, cb?: () => void): void {
    const message = decodeMessage(buf)
    if (!message) throw new Error('the announcer sent something it cannot read back')
    this.sent.push({ message, port, address })
    if (!this.holdSends) cb?.()
  }
  close(): void {
    this.closed = true
  }

  /** A packet arriving from the network. */
  deliver(
    message: Partial<Message> | Buffer,
    from: { address?: string; port?: number } = {}
  ): void {
    const buf = Buffer.isBuffer(message)
      ? message
      : encodeMessage({
          id: 0,
          response: false,
          questions: [],
          answers: [],
          authorities: [],
          additionals: [],
          ...message,
        })
    this.emit('message', buf, {
      address: from.address ?? PHONE,
      port: from.port ?? 5353,
      family: 'IPv4',
      size: buf.length,
    })
  }

  take(): Sent[] {
    return this.sent.splice(0)
  }
}

const CREW = '10.0.0.2'
const PHONE = '10.0.0.50'
const OTHER_BOX = '10.0.0.60'
const SERVICE: Name = ['_crewbox', '_tcp', 'local']

let socket: FakeSocket
let details: ServiceDetails
let announcer: Announcer

const make = (over: Partial<ServiceDetails> = {}) => {
  details = {
    eventId: 'evt-2f1c',
    eventName: 'Ashton Court 2026',
    version: '0.19.0+286be11',
    protocol: 1,
    setUp: true,
    tls: true,
    tlsName: 'chat.example.com',
    ...over,
  }
  announcer = new Announcer({
    address: CREW,
    netmask: '255.255.255.0',
    port: 8787,
    details: () => details,
    createSocket: () => socket as unknown as dgram.Socket,
    // The random delays RFC 6762 asks for, pinned to their shortest.
    random: () => 0,
  })
  return announcer
}

/** Started, probed and announced, with the clock well past the announcements. */
const announced = async (over: Partial<ServiceDetails> = {}) => {
  make(over)
  await announcer.start()
  await vi.advanceTimersByTimeAsync(5000)
  expect(announcer.state).toBe('announced')
  socket.take()
}

const instance = (): Name => [announcer.instanceName, ...SERVICE]
const host = (): Name => [announcer.hostName, 'local']

const find = (records: ResourceRecord[], type: number) => records.find((r) => r.type === type)

const txtOf = (records: ResourceRecord[]): string[] => {
  const txt = find(records, TYPE_TXT)
  return txt?.data.kind === 'txt' ? txt.data.strings.map((s) => s.toString('utf8')) : []
}

beforeEach(() => {
  vi.useFakeTimers()
  socket = new FakeSocket()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('claiming a name', () => {
  it('opens its socket on the crew adapter alone', async () => {
    make()
    await announcer.start()
    expect(socket.bound).toBe(5353)
    expect(socket.memberships).toEqual([['224.0.0.251', CREW]])
    expect(socket.multicastInterface).toBe(CREW)
    // RFC 6762 §11: so a receiver can tell it came from its own link.
    expect(socket.multicastTTL).toBe(255)
    expect(socket.ttl).toBe(255)
  })

  it('probes three times, 250 ms apart, before announcing anything', async () => {
    make()
    await announcer.start()
    await vi.advanceTimersByTimeAsync(0)
    const [first] = socket.take()
    expect(first?.address).toBe('224.0.0.251')
    expect(first?.port).toBe(5353)
    expect(first?.message.response).toBe(false)
    // Asking for a multicast defence: 5353 is shared with the machine's own
    // responder, and a unicast one would reach only one socket on the port,
    // often not ours (RFC 6762 §15.1).
    expect(first?.message.questions).toEqual([
      { name: instance(), type: TYPE_ANY, unicast: false },
      { name: host(), type: TYPE_ANY, unicast: false },
    ])
    // What it would claim goes in the authority section, without the
    // cache-flush bit, which only responses carry.
    const claims = first?.message.authorities ?? []
    expect(claims.map((r) => r.type).sort()).toEqual([TYPE_A, TYPE_TXT, TYPE_SRV].sort())
    expect(claims.every((r) => !r.cacheFlush)).toBe(true)

    await vi.advanceTimersByTimeAsync(249)
    expect(socket.take()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.take()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(socket.take()[0]?.message.response).toBe(false)
    expect(announcer.state).toBe('probing')

    await vi.advanceTimersByTimeAsync(250)
    expect(announcer.state).toBe('announced')
  })

  it('announces twice, a second apart, everything a phone needs', async () => {
    make()
    await announcer.start()
    await vi.advanceTimersByTimeAsync(750)
    const announcements = socket.take().filter((s) => s.message.response)
    expect(announcements).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(socket.take()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.take()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.take()).toHaveLength(0)

    const answers = announcements[0]!.message.answers
    const ptr = answers.find((r) => r.type === TYPE_PTR && r.name.join('.') === SERVICE.join('.'))
    expect(ptr).toMatchObject({ ttl: 4500, cacheFlush: false, data: { target: instance() } })
    // The service type itself, so a browser listing every type finds it.
    const types = answers.find((r) => r.name[0] === '_services')
    expect(types).toMatchObject({ cacheFlush: false, data: { target: SERVICE } })
    expect(find(answers, TYPE_SRV)).toMatchObject({
      name: instance(),
      ttl: 120,
      cacheFlush: true,
      data: { port: 8787, target: host() },
    })
    expect(find(answers, TYPE_TXT)).toMatchObject({ ttl: 4500, cacheFlush: true })
    expect(find(answers, TYPE_A)).toMatchObject({
      name: host(),
      ttl: 120,
      cacheFlush: true,
      data: { address: CREW },
    })
  })

  it('names the service after the event, and the host after its event ID', async () => {
    await announced()
    expect(announcer.instanceName).toBe('Ashton Court 2026')
    expect(announcer.hostName).toMatch(/^crewbox-[0-9a-f]{6}$/)
    const again = new Announcer({
      address: CREW,
      netmask: '255.255.255.0',
      port: 8787,
      details: () => ({ ...details, eventId: 'another-event' }),
    })
    expect(again.hostName).not.toBe(announcer.hostName)
  })

  it('calls an event with no name "crewbox"', async () => {
    await announced({ eventName: '' })
    expect(announcer.instanceName).toBe('crewbox')
  })

  it('cuts a long event name to fit a DNS label without splitting a character', async () => {
    await announced({ eventName: 'é'.repeat(40) })
    expect(announcer.instanceName).toBe('é'.repeat(31))
    expect(Buffer.byteLength(announcer.instanceName)).toBeLessThanOrEqual(63)
  })

  it('says what the join screen says before sign-in, and nothing more', async () => {
    make()
    await announcer.start()
    await vi.advanceTimersByTimeAsync(750)
    const txt = txtOf(socket.take().at(-1)!.message.answers)
    expect(txt).toEqual([
      'txtvers=1',
      'id=evt-2f1c',
      'name=Ashton Court 2026',
      'ver=0.19.0+286be11',
      'proto=1',
      'setup=1',
      'tls=chat.example.com',
    ])
  })

  it('says a new box is not set up, and that a box without a certificate has no TLS', async () => {
    make({ setUp: false, tls: false, tlsName: undefined })
    await announcer.start()
    await vi.advanceTimersByTimeAsync(750)
    const txt = txtOf(socket.take().at(-1)!.message.answers)
    expect(txt).toContain('setup=0')
    expect(txt.some((t) => t.startsWith('tls'))).toBe(false)
  })

  it('fails out loud when the port cannot be opened', async () => {
    socket.bindError = Object.assign(new Error('bind EADDRINUSE 0.0.0.0:5353'), {
      code: 'EADDRINUSE',
    })
    make()
    await expect(announcer.start()).rejects.toThrow(/EADDRINUSE/)
    expect(announcer.state).toBe('failed')
    expect(socket.closed).toBe(true)
  })
})

describe('someone else has the name', () => {
  it('takes the next number when a reply shows the name is taken while probing', async () => {
    make()
    await announcer.start()
    await vi.advanceTimersByTimeAsync(0)
    socket.take()
    socket.deliver(
      {
        response: true,
        answers: [
          {
            name: ['Ashton Court 2026', ...SERVICE],
            type: TYPE_SRV,
            cacheFlush: true,
            ttl: 120,
            data: { kind: 'srv', priority: 0, weight: 0, port: 9000, target: ['other', 'local'] },
          },
        ],
      },
      { address: OTHER_BOX }
    )
    expect(announcer.instanceName).toBe('Ashton Court 2026 (2)')
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.take()[0]?.message.questions[0]?.name).toEqual([
      'Ashton Court 2026 (2)',
      ...SERVICE,
    ])
    await vi.advanceTimersByTimeAsync(750)
    expect(announcer.state).toBe('announced')
  })

  it('keeps the numbered name within a label, too', async () => {
    make({ eventName: 'x'.repeat(80) })
    await announcer.start()
    await vi.advanceTimersByTimeAsync(0)
    socket.deliver(
      {
        response: true,
        answers: [
          {
            name: [announcer.instanceName, ...SERVICE],
            type: TYPE_TXT,
            cacheFlush: true,
            ttl: 4500,
            data: { kind: 'txt', strings: [Buffer.from('someone=else')] },
          },
        ],
      },
      { address: OTHER_BOX }
    )
    expect(announcer.instanceName).toBe(`${'x'.repeat(59)} (2)`)
  })

  it('gives up a name it had announced when another device turns out to hold it', async () => {
    await announced()
    const before = announcer.hostName
    socket.deliver(
      {
        response: true,
        answers: [
          {
            name: host(),
            type: TYPE_A,
            cacheFlush: true,
            ttl: 120,
            data: { kind: 'a', address: OTHER_BOX },
          },
        ],
      },
      { address: OTHER_BOX }
    )
    expect(announcer.hostName).toBe(`${before}-2`)
    expect(announcer.state).toBe('probing')
  })

  it('defends its name at once against a newcomer probing for it', async () => {
    await announced()
    socket.deliver(
      {
        questions: [{ name: instance(), type: TYPE_ANY, unicast: false }],
        authorities: [
          {
            name: instance(),
            type: TYPE_SRV,
            cacheFlush: false,
            ttl: 120,
            data: { kind: 'srv', priority: 0, weight: 0, port: 9000, target: ['other', 'local'] },
          },
        ],
      },
      { address: OTHER_BOX }
    )
    // No delay, and no timers needed: the defence goes out now.
    const [defence] = socket.take()
    expect(defence?.message.response).toBe(true)
    expect(defence?.address).toBe('224.0.0.251')
    expect(defence?.message.answers.map((r) => r.type).sort()).toEqual([TYPE_TXT, TYPE_SRV].sort())
    expect(announcer.instanceName).toBe('Ashton Court 2026')
  })

  it('defends its name even when it answered for it a moment ago', async () => {
    await announced()
    // A phone asks for the service; the answer goes out.
    socket.deliver({ questions: [{ name: instance(), type: TYPE_SRV, unicast: false }] })
    expect(socket.take()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(300)
    // Well inside the second a record normally waits before it goes again,
    // and past the quarter-second a defence waits (RFC 6762 §6).
    socket.deliver(
      {
        questions: [{ name: instance(), type: TYPE_ANY, unicast: false }],
        authorities: [
          {
            name: instance(),
            type: TYPE_SRV,
            cacheFlush: false,
            ttl: 120,
            data: { kind: 'srv', priority: 0, weight: 0, port: 9000, target: ['other', 'local'] },
          },
        ],
      },
      { address: OTHER_BOX }
    )
    const [defence] = socket.take()
    expect(defence?.message.answers.map((r) => r.type)).toContain(TYPE_SRV)
  })

  /** Another host's probe for our instance name, with its SRV on `port`. */
  const rivalProbe = () => (port: number) =>
    socket.deliver(
      {
        questions: [{ name: instance(), type: TYPE_ANY, unicast: true }],
        authorities: [
          {
            name: instance(),
            type: TYPE_SRV,
            cacheFlush: false,
            ttl: 120,
            data: { kind: 'srv', priority: 0, weight: 0, port, target: host() },
          },
          {
            name: instance(),
            type: TYPE_TXT,
            cacheFlush: false,
            ttl: 4500,
            data: {
              kind: 'txt',
              strings: txtOf(socket.sent[0]?.message.authorities ?? []).map((t) => Buffer.from(t)),
            },
          },
        ],
      },
      { address: OTHER_BOX }
    )

  it('backs off for a second when it loses a simultaneous probe', async () => {
    make()
    await announcer.start()
    await vi.advanceTimersByTimeAsync(0)
    // Their SRV names a higher port, so their data sorts later and they win.
    rivalProbe()(9999)
    socket.take()
    await vi.advanceTimersByTimeAsync(999)
    expect(socket.take()).toHaveLength(0)
    // A second, then the usual random wait before a first probe: pinned to
    // none here, though the fake clock runs a timer set while it ticks a
    // millisecond later.
    await vi.advanceTimersByTimeAsync(2)
    expect(socket.take()).toHaveLength(1)
    expect(announcer.state).toBe('probing')
  })

  it('carries on when it wins a simultaneous probe', async () => {
    make()
    await announcer.start()
    await vi.advanceTimersByTimeAsync(0)
    rivalProbe()(1)
    socket.take()
    await vi.advanceTimersByTimeAsync(250)
    expect(socket.take()).toHaveLength(1)
  })

  it('does not mistake its own announcements, coming back to it, for a rival', async () => {
    make()
    await announcer.start()
    await vi.advanceTimersByTimeAsync(0)
    const probe = socket.sent[0]!
    socket.deliver(encodeMessage(probe.message), { address: CREW })
    await vi.advanceTimersByTimeAsync(750)
    const announcement = socket.take().at(-1)!
    socket.deliver(encodeMessage(announcement.message), { address: CREW })
    expect(announcer.instanceName).toBe('Ashton Court 2026')
    expect(announcer.state).toBe('announced')
  })

  it('is not fooled by its own announcement arriving after it changed what it says', async () => {
    await announced({ setUp: false })
    announcer.refresh()
    const old = socket.take().at(-1)!
    details = { ...details, setUp: true }
    announcer.refresh()
    // The earlier packet, carrying setup=0, loops back only now.
    socket.deliver(encodeMessage(old.message), { address: CREW })
    expect(announcer.instanceName).toBe('Ashton Court 2026')
    expect(announcer.state).toBe('announced')
  })
})

describe('answering phones', () => {
  const browse = (over: Partial<Message> = {}, from: { address?: string; port?: number } = {}) =>
    socket.deliver(
      { questions: [{ name: SERVICE, type: TYPE_PTR, unicast: false }], ...over },
      from
    )

  it('answers a phone browsing for boxes, with the rest of what it will ask', async () => {
    await announced()
    browse()
    // A shared record waits 20 to 120 ms, so answers from several boxes
    // spread out rather than colliding.
    await vi.advanceTimersByTimeAsync(19)
    expect(socket.take()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    const [reply] = socket.take()
    expect(reply?.address).toBe('224.0.0.251')
    expect(reply?.message.answers.map((r) => r.type)).toEqual([TYPE_PTR])
    expect(reply?.message.additionals.map((r) => r.type).sort()).toEqual(
      [TYPE_SRV, TYPE_TXT, TYPE_A, TYPE_NSEC].sort()
    )
  })

  it('answers nobody outside the crew network', async () => {
    await announced()
    browse({}, { address: '2.0.0.99' })
    browse({}, { address: '10.0.1.50' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(socket.take()).toHaveLength(0)
  })

  it('leaves out what the phone already knows', async () => {
    await announced()
    const known = (ttl: number): ResourceRecord => ({
      name: SERVICE,
      type: TYPE_PTR,
      cacheFlush: false,
      ttl,
      data: { kind: 'ptr', target: instance() },
    })
    browse({ answers: [known(4000)] })
    await vi.advanceTimersByTimeAsync(200)
    expect(socket.take()).toHaveLength(0)
    // Less than half its life left: worth refreshing.
    browse({ answers: [known(2000)] })
    await vi.advanceTimersByTimeAsync(200)
    expect(socket.take()).toHaveLength(1)
  })

  it('sends a record at most once a second however often it is asked', async () => {
    await announced()
    browse()
    await vi.advanceTimersByTimeAsync(100)
    browse()
    await vi.advanceTimersByTimeAsync(200)
    expect(socket.take()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    browse()
    await vi.advanceTimersByTimeAsync(200)
    expect(socket.take()).toHaveLength(1)
  })

  it('waits for the rest of a question that says more is coming', async () => {
    await announced()
    const truncated = encodeMessage({
      id: 0,
      response: false,
      questions: [{ name: SERVICE, type: TYPE_PTR, unicast: false }],
      answers: [],
      authorities: [],
      additionals: [],
    })
    truncated.writeUInt16BE(0x0200, 2)
    socket.deliver(truncated)
    await vi.advanceTimersByTimeAsync(399)
    expect(socket.take()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.take()).toHaveLength(1)
  })

  /** A query with the TC bit: more of the asker's known answers follow (RFC 6762 §7.2). */
  const moreToCome = (over: Partial<Message> = {}): Buffer => {
    const buf = encodeMessage({
      id: 0,
      response: false,
      questions: [],
      answers: [],
      authorities: [],
      additionals: [],
      ...over,
    })
    buf.writeUInt16BE(buf.readUInt16BE(2) | 0x0200, 2)
    return buf
  }
  const browsing = { questions: [{ name: SERVICE, type: TYPE_PTR, unicast: false }] }
  /** This box, as a phone that has heard of it holds it. */
  const ourPtr = (ttl = 4500): ResourceRecord => ({
    name: SERVICE,
    type: TYPE_PTR,
    cacheFlush: false,
    ttl,
    data: { kind: 'ptr', target: instance() },
  })
  /** Another box, as the same phone holds it. */
  const theirPtr: ResourceRecord = {
    name: SERVICE,
    type: TYPE_PTR,
    cacheFlush: false,
    ttl: 4500,
    data: { kind: 'ptr', target: ['Another Event', ...SERVICE] },
  }

  it('leaves out what the rest of a truncated question says the phone holds', async () => {
    await announced()
    socket.deliver(moreToCome(browsing))
    await vi.advanceTimersByTimeAsync(100)
    // The rest of its known answers: no question, just what it holds.
    socket.deliver({ answers: [theirPtr, ourPtr()] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(socket.take()).toHaveLength(0)
  })

  it('still answers when the rest lists it past half its life, or comes from another device', async () => {
    await announced()
    socket.deliver(moreToCome(browsing))
    socket.deliver({ answers: [ourPtr(2000)] })
    await vi.advanceTimersByTimeAsync(400)
    expect(socket.take()[0]?.message.answers).toMatchObject([{ type: TYPE_PTR }])

    await vi.advanceTimersByTimeAsync(2000)
    socket.deliver(moreToCome(browsing))
    socket.deliver({ answers: [ourPtr()] }, { address: '10.0.0.51' })
    await vi.advanceTimersByTimeAsync(400)
    expect(socket.take()).toHaveLength(1)
  })

  it('still answers another device waiting for the same answer', async () => {
    await announced()
    socket.deliver(moreToCome(browsing))
    socket.deliver(moreToCome(browsing), { address: '10.0.0.51' })
    // The first phone holds it; the second said nothing of the kind.
    socket.deliver({ answers: [ourPtr()] })
    await vi.advanceTimersByTimeAsync(400)
    expect(socket.take()).toHaveLength(1)
  })

  it('answers 400 ms after the last packet saying more is coming', async () => {
    await announced()
    socket.deliver(moreToCome(browsing))
    await vi.advanceTimersByTimeAsync(300)
    // More known answers, and still more after these.
    socket.deliver(moreToCome({ answers: [theirPtr] }))
    await vi.advanceTimersByTimeAsync(399)
    expect(socket.take()).toHaveLength(0)
    // The last of them says no more are coming, and moves nothing.
    socket.deliver({ answers: [] })
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.take()[0]?.message.answers).toMatchObject([{ type: TYPE_PTR }])
  })

  it('drops a held answer when it has to claim its name again, and answers the next', async () => {
    await announced()
    socket.deliver(moreToCome(browsing))
    // Another device turns out to hold the host name, so the box claims another.
    socket.deliver(
      {
        response: true,
        answers: [
          {
            name: host(),
            type: TYPE_A,
            cacheFlush: true,
            ttl: 120,
            data: { kind: 'a', address: OTHER_BOX },
          },
        ],
      },
      { address: OTHER_BOX }
    )
    await vi.advanceTimersByTimeAsync(5000)
    expect(announcer.state).toBe('announced')
    socket.take()
    socket.deliver(moreToCome(browsing))
    await vi.advanceTimersByTimeAsync(400)
    expect(socket.take()).toHaveLength(1)
  })

  it('brings the address when a phone resolves the service, and says there is no other', async () => {
    await announced()
    // Android asks for the address only once it knows the host's name, so
    // without it here that is another round of questions.
    socket.deliver({ questions: [{ name: instance(), type: TYPE_SRV, unicast: false }] })
    const [reply] = socket.take()
    expect(reply?.message.answers).toMatchObject([{ type: TYPE_SRV }])
    expect(reply?.message.additionals).toMatchObject([
      { type: TYPE_A, name: host(), data: { address: CREW } },
      { type: TYPE_NSEC, name: host(), data: { next: host(), types: [TYPE_A] } },
    ])
  })

  it('answers its own address at once, and says it has no IPv6 one', async () => {
    await announced()
    socket.deliver({ questions: [{ name: host(), type: TYPE_A, unicast: false }] })
    const [reply] = socket.take()
    expect(reply?.message.answers).toMatchObject([{ type: TYPE_A, data: { address: CREW } }])
    expect(reply?.message.additionals).toMatchObject([
      { type: TYPE_NSEC, data: { types: [TYPE_A] } },
    ])

    await vi.advanceTimersByTimeAsync(2000)
    socket.deliver({ questions: [{ name: host(), type: TYPE_AAAA, unicast: false }] })
    expect(socket.take()[0]?.message.answers).toMatchObject([
      { type: TYPE_NSEC, name: host(), data: { next: host(), types: [TYPE_A] } },
    ])
  })

  it('answers a one-shot question straight back, the way RFC 6762 §6.7 asks', async () => {
    await announced()
    socket.deliver(
      { id: 0x1234, questions: [{ name: host(), type: TYPE_A, unicast: false }] },
      { port: 53123 }
    )
    const [reply] = socket.take()
    expect(reply?.address).toBe(PHONE)
    expect(reply?.port).toBe(53123)
    expect(reply?.message.id).toBe(0x1234)
    expect(reply?.message.questions).toEqual([{ name: host(), type: TYPE_A, unicast: false }])
    for (const r of [...(reply?.message.answers ?? []), ...(reply?.message.additionals ?? [])]) {
      expect(r.ttl).toBeLessThanOrEqual(10)
      expect(r.cacheFlush).toBe(false)
    }
  })

  it('answers a question asking for a unicast reply with one, when the record went out lately', async () => {
    await announced()
    socket.deliver({ questions: [{ name: instance(), type: TYPE_SRV, unicast: true }] })
    const [reply] = socket.take()
    expect(reply?.address).toBe(PHONE)
    expect(reply?.port).toBe(5353)
  })

  it('multicasts it instead when the record has not gone out for a while', async () => {
    await announced()
    await vi.advanceTimersByTimeAsync(31_000)
    socket.deliver({ questions: [{ name: instance(), type: TYPE_SRV, unicast: true }] })
    expect(socket.take()[0]?.address).toBe('224.0.0.251')
  })

  it('answers nothing while it is still probing', async () => {
    make()
    await announcer.start()
    await vi.advanceTimersByTimeAsync(0)
    socket.take()
    browse()
    await vi.advanceTimersByTimeAsync(200)
    expect(socket.take().filter((s) => s.message.response)).toHaveLength(0)
  })

  it('ignores junk', async () => {
    await announced()
    expect(() => socket.deliver(Buffer.from('not dns at all'))).not.toThrow()
    expect(() => socket.deliver(Buffer.alloc(0))).not.toThrow()
    await vi.advanceTimersByTimeAsync(500)
    expect(socket.take()).toHaveLength(0)
  })

  it('ignores questions about other devices', async () => {
    await announced()
    socket.deliver({
      questions: [{ name: ['_airplay', '_tcp', 'local'], type: TYPE_PTR, unicast: false }],
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(socket.take()).toHaveLength(0)
  })
})

describe('changing and stopping', () => {
  it('announces again in place when what it says changes', async () => {
    await announced({ setUp: false })
    details = { ...details, setUp: true }
    announcer.refresh()
    const [again] = socket.take()
    expect(txtOf(again?.message.answers ?? [])).toContain('setup=1')
    expect(announcer.state).toBe('announced')
  })

  it('says goodbye to the old name when the event is renamed, then claims the new one', async () => {
    await announced()
    const oldInstance = instance()
    details = { ...details, eventName: 'Ashton Court 2027' }
    announcer.refresh()
    const [goodbye] = socket.take()
    expect(goodbye?.message.answers.every((r) => r.ttl === 0)).toBe(true)
    const ptr = goodbye?.message.answers.find((r) => r.type === TYPE_PTR)
    expect(ptr?.data).toMatchObject({ target: oldInstance })
    expect(announcer.state).toBe('probing')
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.take()[0]?.message.questions[0]?.name).toEqual(['Ashton Court 2027', ...SERVICE])
  })

  it('says goodbye when it stops, so phones drop it now rather than in an hour', async () => {
    await announced()
    await announcer.stop()
    const [goodbye] = socket.take()
    expect(goodbye?.address).toBe('224.0.0.251')
    const answers = goodbye?.message.answers ?? []
    expect(answers.map((r) => r.type).sort()).toEqual([TYPE_PTR, TYPE_SRV, TYPE_TXT, TYPE_A].sort())
    expect(answers.every((r) => r.ttl === 0)).toBe(true)
    // Not the list of service types: another box may still offer this one.
    expect(answers.some((r) => r.name[0] === '_services')).toBe(false)
    expect(socket.closed).toBe(true)
    expect(announcer.state).toBe('stopped')
  })

  it('does not hold up an update waiting for a goodbye that never goes', async () => {
    await announced()
    socket.holdSends = true
    let done = false
    const stopping = announcer.stop().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(done).toBe(true)
    expect(socket.closed).toBe(true)
  })

  it('ends, and keeps the reason, when sending fails after it started', async () => {
    await announced()
    socket.emit('error', new Error('send EHOSTUNREACH 224.0.0.251:5353'))
    expect(announcer.state).toBe('failed')
    expect(announcer.error).toMatch(/EHOSTUNREACH/)
    expect(socket.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(socket.take()).toHaveLength(0)
  })

  it('stops without a goodbye when it never announced anything', async () => {
    make()
    await announcer.start()
    await vi.advanceTimersByTimeAsync(0)
    socket.take()
    await announcer.stop()
    expect(socket.take()).toHaveLength(0)
    expect(socket.closed).toBe(true)
    // And nothing left ticking to probe on a closed socket.
    await vi.advanceTimersByTimeAsync(5000)
    expect(socket.take()).toHaveLength(0)
  })
})
