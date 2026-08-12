import dgram from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TAG_SEQUENCE,
  decodeInteger,
  decodeOid,
  encodeInteger,
  encodeOctetString,
  encodeOid,
  encodeTlv,
  readSequence,
  readTlv,
} from '../src/video/ber.ts'
import {
  GET_REQUEST,
  GET_RESPONSE,
  MAX_VARBINDS,
  SnmpSession,
  SnmpError,
  decodeResponse,
  encodeGet,
  readOverSnmp,
} from '../src/video/snmp.ts'
import * as oid from '../src/video/oids.ts'

/**
 * The SNMP reader, against a fake agent on loopback.
 *
 * A real socket rather than a stub, because the thing most likely to be wrong
 * in a hand-rolled codec is the bytes, and a stub that agrees with the encoder
 * would not notice. The agent below answers from a table, so a test can say
 * "this controller has four temperature points" and check what the reader
 * makes of it.
 */

interface FakeAgent {
  port: number
  close: () => void
  /** Every OID the reader asked for, in order, across all requests. */
  asked: string[]
  requests: number
}

/** Answer GETs from `table`; anything absent comes back as noSuchObject. */
async function startAgent(table: Record<string, string | number>): Promise<FakeAgent> {
  const socket = dgram.createSocket('udp4')
  const asked: string[] = []
  const state = { requests: 0 }

  socket.on('message', (buf, rinfo) => {
    const message = readTlv(buf, 0)
    const [, , pdu] = readSequence(message.value)
    if (pdu.tag !== GET_REQUEST) return
    state.requests++
    const [id, , , list] = readSequence(pdu.value)
    const requestId = decodeInteger(id.value)
    const answers: Buffer[] = []
    for (const entry of readSequence(list.value)) {
      const [name] = readSequence(entry.value)
      const asked_ = decodeOid(name.value)
      asked.push(asked_)
      const value = table[asked_]
      const encoded =
        value === undefined
          ? encodeTlv(0x80, Buffer.alloc(0))
          : typeof value === 'number'
            ? encodeInteger(value)
            : encodeOctetString(value)
      answers.push(encodeTlv(TAG_SEQUENCE, Buffer.concat([encodeOid(asked_), encoded])))
    }
    const responsePdu = encodeTlv(
      GET_RESPONSE,
      Buffer.concat([
        encodeInteger(requestId),
        encodeInteger(0),
        encodeInteger(0),
        encodeTlv(TAG_SEQUENCE, Buffer.concat(answers)),
      ])
    )
    const reply = encodeTlv(
      TAG_SEQUENCE,
      Buffer.concat([encodeInteger(1), encodeOctetString('public'), responsePdu])
    )
    socket.send(reply, rinfo.port, rinfo.address)
  })

  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
  const port = (socket.address() as { port: number }).port
  return {
    port,
    close: () => socket.close(),
    asked,
    get requests() {
      return state.requests
    },
  }
}

const io = {
  createSocket: (o: dgram.SocketOptions) => dgram.createSocket(o),
  now: () => Date.now(),
}

let agent: FakeAgent | null = null
afterEach(() => {
  agent?.close()
  agent = null
})

describe('encoding a GET', () => {
  it('produces a GetRequest and nothing else', () => {
    const packet = encodeGet('public', 7, ['1.3.6.1.4.1.319.10.10.1.2'])
    const [version, community, pdu] = readSequence(readTlv(packet, 0).value)
    expect(decodeInteger(version.value)).toBe(1) // SNMPv2c
    expect(community.value.toString()).toBe('public')
    expect(pdu.tag).toBe(GET_REQUEST)
  })

  it('refuses more OIDs than fit one datagram', () => {
    const many = Array.from({ length: MAX_VARBINDS + 1 }, (_, i) => `1.3.6.1.4.1.319.${i}`)
    expect(() => encodeGet('public', 1, many)).toThrow(SnmpError)
  })

  it('refuses an empty GET', () => {
    expect(() => encodeGet('public', 1, [])).toThrow(SnmpError)
  })
})

describe('decoding a response', () => {
  it('rejects a PDU that is not a GetResponse', () => {
    // A SetRequest arriving at the box is not something to act on, and this
    // is the layer that says so — the encoder cannot produce one, and the
    // decoder will not accept one either.
    const setRequest = encodeTlv(
      0xa3,
      Buffer.concat([
        encodeInteger(1),
        encodeInteger(0),
        encodeInteger(0),
        encodeTlv(TAG_SEQUENCE, Buffer.alloc(0)),
      ])
    )
    const message = encodeTlv(
      TAG_SEQUENCE,
      Buffer.concat([encodeInteger(1), encodeOctetString('public'), setRequest])
    )
    expect(() => decodeResponse(message)).toThrow(SnmpError)
  })

  it('reads noSuchObject as "nothing there", not as a failure', () => {
    const varbind = encodeTlv(
      TAG_SEQUENCE,
      Buffer.concat([encodeOid('1.3.6.1'), encodeTlv(0x80, Buffer.alloc(0))])
    )
    const pdu = encodeTlv(
      GET_RESPONSE,
      Buffer.concat([
        encodeInteger(1),
        encodeInteger(0),
        encodeInteger(0),
        encodeTlv(TAG_SEQUENCE, varbind),
      ])
    )
    const message = encodeTlv(
      TAG_SEQUENCE,
      Buffer.concat([encodeInteger(1), encodeOctetString('public'), pdu])
    )
    expect(decodeResponse(message).varbinds[0].value).toBeNull()
  })
})

describe('reading a controller', () => {
  it('reads identity, temperature, fans and inputs', async () => {
    agent = await startAgent({
      [oid.CONTROLLER_MODEL]: 'MX40 Pro',
      [oid.CONTROLLER_NAME]: 'Main wall',
      [oid.CONTROLLER_SERIAL]: 'SN-00042',
      [oid.CONTROLLER_FIRMWARE]: 'v1.4.0',
      [oid.CONTROLLER_ROLE]: 0,
      [oid.TEMPERATURE_POINT_COUNT]: 2,
      [oid.FAN_COUNT]: 2,
      [oid.SCREEN_COUNT]: 1,
      [oid.INPUT_SLOT_COUNT]: 1,
      [oid.at(oid.TEMPERATURE_POINT_VALUE, 1)]: 41,
      [oid.at(oid.TEMPERATURE_POINT_VALUE, 2)]: 47,
      [oid.at(oid.FAN_STATUS, 1)]: 0,
      [oid.at(oid.FAN_STATUS, 2)]: 0,
      [oid.at(oid.SCREEN_BRIGHTNESS, 1)]: 65,
      [oid.at(oid.INPUT_SOURCE_COUNT, 1)]: 2,
      [oid.at(oid.INPUT_SOURCE_SIGNAL, 1, 1)]: 1,
      [oid.at(oid.INPUT_SOURCE_TYPE, 1, 1)]: 9,
      [oid.at(oid.INPUT_SOURCE_SIGNAL, 1, 2)]: 2,
      [oid.at(oid.INPUT_SOURCE_TYPE, 1, 2)]: 3,
      [oid.at(oid.ETHERNET_PORT_COUNT, 1)]: 0,
    })
    const session = new SnmpSession('127.0.0.1', io, 'public', agent.port)
    const reading = await readOverSnmp(session, 1_000)

    expect(reading.readPath).toBe('snmp')
    expect(reading.model).toBe('MX40 Pro')
    expect(reading.reportedName).toBe('Main wall')
    expect(reading.serial).toBe('SN-00042')
    expect(reading.isBackup).toBe(false)
    expect(reading.snmpEnabled).toBe(true)
    // The hottest point, not the first or an average: one point over the line
    // is the thing worth walking over to look at.
    expect(reading.temperature).toBe(47)
    expect(reading.fanFault).toBe(false)
    expect(reading.brightness).toBe(65)
    expect(reading.inputs).toEqual([
      { id: '1.1', signal: 'present', connector: '12G-SDI' },
      { id: '1.2', signal: 'no-signal', connector: 'HDMI 2.0' },
    ])
    expect(reading.errors).toEqual([])
  })

  it('reports receiving cards per port, with status rather than degrees', async () => {
    agent = await startAgent({
      [oid.CONTROLLER_MODEL]: 'MX40 Pro',
      [oid.TEMPERATURE_POINT_COUNT]: 0,
      [oid.FAN_COUNT]: 0,
      [oid.SCREEN_COUNT]: 0,
      [oid.INPUT_SLOT_COUNT]: 0,
      [oid.at(oid.ETHERNET_PORT_COUNT, 1)]: 2,
      [oid.at(oid.RECEIVING_CARDS_ONLINE, 1, 1)]: 2,
      [oid.at(oid.RECEIVING_CARDS_ONLINE, 1, 2)]: 1,
      [oid.at(oid.RECEIVING_CARD_TEMPERATURE_STATUS, 1, 1, 1)]: 0,
      [oid.at(oid.RECEIVING_CARD_TEMPERATURE_STATUS, 1, 1, 2)]: 1,
      [oid.at(oid.RECEIVING_CARD_TEMPERATURE_STATUS, 1, 2, 1)]: 0,
      [oid.at(oid.ETHERNET_PORT_COUNT, 2)]: 0,
    })
    const session = new SnmpSession('127.0.0.1', io, 'public', agent.port)
    const reading = await readOverSnmp(session, 1_000)

    expect(reading.cabinets).toHaveLength(3)
    // SNMP gives normal/abnormal, never a number of degrees, and the reading
    // says so rather than inventing one.
    expect(reading.cabinets[1]).toEqual({
      id: '1.1.2',
      screen: 'port 1',
      online: true,
      tempStatus: 'abnormal',
    })
    expect(reading.cabinets.every((c) => c.temperature === undefined)).toBe(true)
    expect(reading.cardFaults).toBe(1)
  })

  it('stops walking output cards at the first empty slot', async () => {
    agent = await startAgent({
      [oid.CONTROLLER_MODEL]: 'CX40 Pro',
      [oid.TEMPERATURE_POINT_COUNT]: 0,
      [oid.FAN_COUNT]: 0,
      [oid.SCREEN_COUNT]: 0,
      [oid.INPUT_SLOT_COUNT]: 0,
      [oid.at(oid.ETHERNET_PORT_COUNT, 1)]: 0,
    })
    const session = new SnmpSession('127.0.0.1', io, 'public', agent.port)
    await readOverSnmp(session, 1_000)
    // Card 1 reports no ports, so cards 2-8 are never asked about. A full
    // sweep of the bound would be seven pointless packets per poll on every
    // chassis smaller than the maximum, which is all of them.
    expect(agent.asked.filter((o) => o.startsWith(`${oid.CONTROLLER}.30.5`))).toEqual([
      oid.at(oid.ETHERNET_PORT_COUNT, 1),
    ])
  })

  it('bounds a nonsense count instead of flooding the network', async () => {
    agent = await startAgent({
      [oid.CONTROLLER_MODEL]: 'MX40 Pro',
      // Broken firmware, or something that is not a controller at all.
      [oid.TEMPERATURE_POINT_COUNT]: 4_000_000_000,
      [oid.FAN_COUNT]: 0,
      [oid.SCREEN_COUNT]: 0,
      [oid.INPUT_SLOT_COUNT]: 0,
      [oid.at(oid.ETHERNET_PORT_COUNT, 1)]: 0,
    })
    const session = new SnmpSession('127.0.0.1', io, 'public', agent.port)
    await readOverSnmp(session, 1_000)
    const temps = agent.asked.filter((o) => o.startsWith(`${oid.CONTROLLER}.10.2.`))
    expect(temps).toHaveLength(oid.MAX_TEMPERATURE_POINTS)
  })

  it('returns an empty reading rather than throwing when nothing answers', async () => {
    // Port 1 on loopback has no SNMP agent, and never will.
    const session = new SnmpSession('127.0.0.1', io, 'public', 1)
    const reading = await readOverSnmp(session, 1_000)
    expect(reading.model).toBeUndefined()
    expect(reading.errors.length).toBeGreaterThan(0)
  }, 10_000)
})
