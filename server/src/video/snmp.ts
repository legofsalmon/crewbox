import dgram from 'node:dgram'
import {
  SNMP_PORT,
  type CabinetReading,
  type InputReading,
  type InputSignal,
  type ProcessorReading,
} from '@crewbox/shared'
import {
  BerError,
  TAG_END_OF_MIB,
  TAG_INTEGER,
  TAG_NO_SUCH_INSTANCE,
  TAG_NO_SUCH_OBJECT,
  TAG_OCTET_STRING,
  TAG_OID,
  TAG_SEQUENCE,
  decodeInteger,
  decodeOid,
  encodeInteger,
  encodeNull,
  encodeOctetString,
  encodeOid,
  encodeTlv,
  readSequence,
  readTlv,
} from './ber.ts'
import * as oid from './oids.ts'

/**
 * SNMPv2c, GET only.
 *
 * This is the interface NovaStar publishes for exactly this purpose, and it
 * is read-only by construction on the GET side — which is why it is the path
 * crewbox prefers over the HTTP API when a controller has it switched on.
 *
 * `PduType` has two members and there is no third. SetRequest is 0xa3; that
 * byte does not appear in this codebase, and `video-readonly.test.ts` asserts
 * it by reading every file in this directory. The guarantee is meant to
 * survive people who have never read this comment.
 *
 * Two things crewbox cannot do, both writes, both surfaced as states rather
 * than attempted: switching SNMP on at the controller, and configuring a trap
 * target so the controller pushes changes instead of being polled. A box that
 * finds SNMP off falls back to the HTTP API and says so.
 */

/** The only two PDUs this codebase can produce. */
export const GET_REQUEST = 0xa0
export const GET_NEXT_REQUEST = 0xa1
export type PduType = typeof GET_REQUEST | typeof GET_NEXT_REQUEST

/** What an agent sends back. Decoded, never encoded. */
export const GET_RESPONSE = 0xa2

/** SNMPv2c. Version 1 would be `0`; v3 is a different protocol entirely. */
export const VERSION_2C = 1

/**
 * The read community.
 *
 * Not a secret and not treated as one — SNMPv2c has no encryption and
 * "public" is the default every COEX controller ships with. It is
 * configurable because some venues change it, and if a venue has changed it
 * they will tell you what to.
 */
export const DEFAULT_COMMUNITY = 'public'

/** One request's ceiling. A controller that hasn't answered by now is not going to. */
export const SNMP_TIMEOUT_MS = 2_000

/**
 * OIDs per request.
 *
 * SNMP allows many varbinds in one GET, which is the difference between one
 * packet and thirty for a full walk. Kept well inside a 1500-byte MTU so no
 * response has to fragment.
 */
export const MAX_VARBINDS = 16

export interface Varbind {
  oid: string
  value: string | number | null
}

export interface SnmpIo {
  createSocket: (options: dgram.SocketOptions) => dgram.Socket
  now: () => number
}

export class SnmpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnmpError'
  }
}

/**
 * Build a GetRequest.
 *
 * `type` is `PduType`, so the call site cannot pass 0xa3 — the compiler
 * rejects it before it is a runtime concern.
 */
export function encodeGet(
  community: string,
  requestId: number,
  oids: string[],
  type: PduType = GET_REQUEST
): Buffer {
  if (oids.length === 0) throw new SnmpError('a GET needs at least one OID')
  if (oids.length > MAX_VARBINDS) throw new SnmpError(`too many OIDs in one GET (${oids.length})`)
  const varbinds = oids.map((o) =>
    encodeTlv(TAG_SEQUENCE, Buffer.concat([encodeOid(o), encodeNull()]))
  )
  const pdu = encodeTlv(
    type,
    Buffer.concat([
      encodeInteger(requestId),
      encodeInteger(0), // error-status: always 0 in a request
      encodeInteger(0), // error-index
      encodeTlv(TAG_SEQUENCE, Buffer.concat(varbinds)),
    ])
  )
  return encodeTlv(
    TAG_SEQUENCE,
    Buffer.concat([encodeInteger(VERSION_2C), encodeOctetString(community), pdu])
  )
}

export interface SnmpResponse {
  requestId: number
  errorStatus: number
  varbinds: Varbind[]
}

/** Decode a GetResponse. Anything else — including a SetRequest — is rejected. */
export function decodeResponse(buf: Buffer): SnmpResponse {
  const message = readTlv(buf, 0)
  if (message.tag !== TAG_SEQUENCE) throw new SnmpError('not an SNMP message')
  const [version, community, pdu] = readSequence(message.value)
  if (!version || !community || !pdu) throw new SnmpError('truncated SNMP message')
  if (pdu.tag !== GET_RESPONSE) throw new SnmpError(`unexpected PDU 0x${pdu.tag.toString(16)}`)

  const parts = readSequence(pdu.value)
  const [id, status, , list] = parts
  if (!id || !status || !list) throw new SnmpError('truncated PDU')
  const varbinds: Varbind[] = []
  for (const entry of readSequence(list.value)) {
    if (entry.tag !== TAG_SEQUENCE) continue
    const [name, value] = readSequence(entry.value)
    if (!name || name.tag !== TAG_OID || !value) continue
    varbinds.push({ oid: decodeOid(name.value), value: decodeValue(value.tag, value.value) })
  }
  return {
    requestId: decodeInteger(id.value),
    errorStatus: decodeInteger(status.value),
    varbinds,
  }
}

/** `null` means the agent has nothing there — a normal answer, not a failure. */
function decodeValue(tag: number, value: Buffer): string | number | null {
  if (tag === TAG_NO_SUCH_OBJECT || tag === TAG_NO_SUCH_INSTANCE || tag === TAG_END_OF_MIB) {
    return null
  }
  if (tag === TAG_OCTET_STRING) return value.toString('utf8').replace(/\0+$/, '')
  if (tag === TAG_OID) return decodeOid(value)
  if (tag === TAG_INTEGER || (tag >= 0x41 && tag <= 0x46)) return decodeInteger(value)
  if (value.length === 0) return null
  return value.toString('utf8')
}

/**
 * One SNMP conversation with one controller.
 *
 * A fresh socket per request, closed in `finally`. That costs a file
 * descriptor per poll and buys the property that this module holds nothing
 * open on a show network between polls.
 */
export class SnmpSession {
  private readonly io: SnmpIo
  private readonly host: string
  private readonly community: string
  private readonly port: number
  private readonly localAddress: string
  private nextRequestId = 1

  constructor(
    host: string,
    io: SnmpIo,
    community = DEFAULT_COMMUNITY,
    port = SNMP_PORT,
    /**
     * The video adapter's own address, when the box has one pinned.
     *
     * Without it the datagram leaves on whatever the routing table picks,
     * which on a box holding both the crew Wi-Fi and a video VLAN is a coin
     * flip — and the wrong side of that flip puts monitoring traffic on the
     * network the crew's phones are on. `CREWBOX_VIDEO_IFACE` is already how
     * an admin says which adapter faces the wall; this makes the reader
     * honour it, rather than only the discovery scan.
     */
    localAddress = ''
  ) {
    this.host = host
    this.io = io
    this.community = community
    this.port = port
    this.localAddress = localAddress
  }

  async get(oids: string[]): Promise<Map<string, string | number | null>> {
    const out = new Map<string, string | number | null>()
    for (let i = 0; i < oids.length; i += MAX_VARBINDS) {
      const batch = oids.slice(i, i + MAX_VARBINDS)
      const response = await this.exchange(batch)
      for (const vb of response.varbinds) out.set(vb.oid, vb.value)
    }
    return out
  }

  private exchange(oids: string[]): Promise<SnmpResponse> {
    const requestId = this.nextRequestId++
    const packet = encodeGet(this.community, requestId, oids)
    const socket = this.io.createSocket({ type: 'udp4' })

    return new Promise<SnmpResponse>((resolve, reject) => {
      let settled = false
      const finish = (err: Error | null, value?: SnmpResponse) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          socket.close()
        } catch {
          // Already closed, or never bound. Nothing to do either way.
        }
        if (err) reject(err)
        else resolve(value as SnmpResponse)
      }

      const timer = setTimeout(() => finish(new SnmpError('no answer')), SNMP_TIMEOUT_MS)
      timer.unref?.()

      socket.on('error', (err) => finish(err))
      socket.on('message', (buf) => {
        try {
          const response = decodeResponse(buf)
          // A late reply to a previous request is not this request's answer.
          if (response.requestId !== requestId) return
          finish(null, response)
        } catch (err) {
          if (err instanceof BerError || err instanceof SnmpError) return // not ours
          finish(err as Error)
        }
      })
      const send = () =>
        socket.send(packet, this.port, this.host, (err) => {
          if (err) finish(err)
        })
      // Bound before sending when an adapter is pinned, so the source address
      // — and therefore the route out — is the video network rather than
      // whatever the table would have chosen. Port 0: this is a client
      // socket, and it is closed in `finish`.
      if (this.localAddress) socket.bind({ address: this.localAddress, port: 0 }, send)
      else send()
    })
  }
}

const SIGNAL_BY_CODE: Record<number, InputSignal> = {
  0: 'not-connected',
  1: 'present',
  2: 'no-signal',
}

const asNumber = (v: string | number | null | undefined): number | undefined =>
  typeof v === 'number'
    ? v
    : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))
      ? Number(v)
      : undefined

const asString = (v: string | number | null | undefined): string | undefined =>
  typeof v === 'string' && v.trim() !== ''
    ? v.trim()
    : typeof v === 'number'
      ? String(v)
      : undefined

/** Clamp a count that came off the wire before it is used to build requests. */
const bounded = (value: number | undefined, max: number): number =>
  value === undefined || value < 0 ? 0 : Math.min(Math.floor(value), max)

/**
 * A full read over SNMP.
 *
 * Three rounds: identity and counts, then the tables those counts size, then
 * the per-source detail. Each round is bounded by the constants in `oids.ts`,
 * so a controller reporting nonsense costs a handful of packets rather than
 * an unbounded sweep.
 *
 * Never throws. A round that fails leaves its fields absent and adds a line
 * to `errors`; the caller decides whether an empty reading means "not there".
 */
export async function readOverSnmp(session: SnmpSession, now: number): Promise<ProcessorReading> {
  const errors: string[] = []
  const reading: ProcessorReading = { at: now, readPath: 'snmp', cabinets: [], inputs: [], errors }

  let identity: Map<string, string | number | null>
  try {
    identity = await session.get([
      oid.CONTROLLER_MODEL,
      oid.CONTROLLER_NAME,
      oid.CONTROLLER_SERIAL,
      oid.CONTROLLER_FIRMWARE,
      oid.CONTROLLER_ROLE,
      oid.TEMPERATURE_POINT_COUNT,
      oid.FAN_COUNT,
      oid.SCREEN_COUNT,
      oid.INPUT_SLOT_COUNT,
      oid.OUTPUT_SLOT_STATUS,
    ])
  } catch (err) {
    errors.push(`identity: ${err instanceof Error ? err.message : 'failed'}`)
    return reading
  }

  const model = asString(identity.get(oid.CONTROLLER_MODEL))
  const name = asString(identity.get(oid.CONTROLLER_NAME))
  const serial = asString(identity.get(oid.CONTROLLER_SERIAL))
  const firmware = asString(identity.get(oid.CONTROLLER_FIRMWARE))
  const role = asNumber(identity.get(oid.CONTROLLER_ROLE))
  if (model) reading.model = model
  if (name) reading.reportedName = name
  if (serial) reading.serial = serial
  if (firmware) reading.firmware = firmware
  if (role !== undefined) reading.isBackup = role === 1
  // We got an answer over SNMP, so it is on by definition.
  reading.snmpEnabled = true

  const tempPoints = bounded(
    asNumber(identity.get(oid.TEMPERATURE_POINT_COUNT)),
    oid.MAX_TEMPERATURE_POINTS
  )
  const fans = bounded(asNumber(identity.get(oid.FAN_COUNT)), oid.MAX_FANS)
  const screens = bounded(asNumber(identity.get(oid.SCREEN_COUNT)), oid.MAX_SCREENS)
  const inputCards = bounded(asNumber(identity.get(oid.INPUT_SLOT_COUNT)), oid.MAX_INPUT_CARDS)

  const health: string[] = []
  for (let n = 1; n <= tempPoints; n++) health.push(oid.at(oid.TEMPERATURE_POINT_VALUE, n))
  for (let n = 1; n <= fans; n++) health.push(oid.at(oid.FAN_STATUS, n))
  for (let n = 1; n <= screens; n++) health.push(oid.at(oid.SCREEN_BRIGHTNESS, n))
  for (let n = 1; n <= inputCards; n++) health.push(oid.at(oid.INPUT_SOURCE_COUNT, n))

  let sizes = new Map<string, string | number | null>()
  if (health.length > 0) {
    try {
      sizes = await session.get(health)
    } catch (err) {
      errors.push(`health: ${err instanceof Error ? err.message : 'failed'}`)
    }
  }

  const temps: number[] = []
  for (let n = 1; n <= tempPoints; n++) {
    const value = asNumber(sizes.get(oid.at(oid.TEMPERATURE_POINT_VALUE, n)))
    if (value !== undefined) temps.push(value)
  }
  if (temps.length > 0) reading.temperature = Math.max(...temps)

  let fanFault = false
  for (let n = 1; n <= fans; n++) {
    if (asNumber(sizes.get(oid.at(oid.FAN_STATUS, n))) === oid.ABNORMAL) fanFault = true
  }
  if (fans > 0) reading.fanFault = fanFault

  // First screen's brightness. A wall driven as several screens at different
  // levels is a real setup, but a single number in a phone-sized row would be
  // a lie about the others — so this is the first screen's, and the pane says
  // so when there is more than one.
  if (screens > 0) {
    const brightness = asNumber(sizes.get(oid.at(oid.SCREEN_BRIGHTNESS, 1)))
    if (brightness !== undefined) reading.brightness = brightness
  }

  const sourceOids: string[] = []
  const sourceIndex: Array<{ card: number; source: number }> = []
  for (let card = 1; card <= inputCards; card++) {
    const count = bounded(
      asNumber(sizes.get(oid.at(oid.INPUT_SOURCE_COUNT, card))),
      oid.MAX_SOURCES_PER_CARD
    )
    for (let source = 1; source <= count; source++) {
      sourceOids.push(oid.at(oid.INPUT_SOURCE_SIGNAL, card, source))
      sourceOids.push(oid.at(oid.INPUT_SOURCE_TYPE, card, source))
      sourceIndex.push({ card, source })
    }
  }

  if (sourceOids.length > 0) {
    try {
      const detail = await session.get(sourceOids)
      const inputs: InputReading[] = []
      for (const { card, source } of sourceIndex) {
        const code = asNumber(detail.get(oid.at(oid.INPUT_SOURCE_SIGNAL, card, source)))
        const typeCode = asNumber(detail.get(oid.at(oid.INPUT_SOURCE_TYPE, card, source)))
        const connector =
          typeCode !== undefined
            ? oid.SOURCE_TYPES[typeCode]
            : asString(detail.get(oid.at(oid.INPUT_SOURCE_TYPE, card, source)))
        inputs.push({
          id: `${card}.${source}`,
          signal: (code !== undefined && SIGNAL_BY_CODE[code]) || 'not-connected',
          ...(connector ? { connector } : {}),
        })
      }
      reading.inputs = inputs
    } catch (err) {
      errors.push(`inputs: ${err instanceof Error ? err.message : 'failed'}`)
    }
  }

  reading.cabinets = await readCabinets(session, errors)
  const abnormal = reading.cabinets.filter((c) => c.tempStatus === 'abnormal').length
  if (abnormal > 0) reading.cardFaults = abnormal
  return reading
}

/**
 * Receiving cards, port by port.
 *
 * SNMP calls these receiving cards; the HTTP API calls the same things
 * cabinets. They are the same physical panels, so both land in `cabinets` —
 * but note what SNMP gives and what it does not: a per-card *status*
 * (normal/abnormal), never a temperature in degrees. `tempStatus` carries the
 * first; `temperature` stays absent rather than being filled with a plausible
 * number.
 */
async function readCabinets(session: SnmpSession, errors: string[]): Promise<CabinetReading[]> {
  const cabinets: CabinetReading[] = []
  for (let card = 1; card <= oid.MAX_OUTPUT_CARDS; card++) {
    let ports: number
    try {
      const answer = await session.get([oid.at(oid.ETHERNET_PORT_COUNT, card)])
      ports = bounded(
        asNumber(answer.get(oid.at(oid.ETHERNET_PORT_COUNT, card))),
        oid.MAX_PORTS_PER_CARD
      )
    } catch (err) {
      errors.push(`output card ${card}: ${err instanceof Error ? err.message : 'failed'}`)
      break
    }
    // A slot with no card reports no ports, and slots run out before the
    // bound does. Stopping here saves a poll's worth of packets per absent
    // card on every chassis smaller than the maximum, which is all of them.
    if (ports === 0) break

    const onlineOids = Array.from({ length: ports }, (_, i) =>
      oid.at(oid.RECEIVING_CARDS_ONLINE, card, i + 1)
    )
    let online: Map<string, string | number | null>
    try {
      online = await session.get(onlineOids)
    } catch (err) {
      errors.push(`card ${card} ports: ${err instanceof Error ? err.message : 'failed'}`)
      continue
    }

    for (let port = 1; port <= ports; port++) {
      const count = bounded(
        asNumber(online.get(oid.at(oid.RECEIVING_CARDS_ONLINE, card, port))),
        512
      )
      if (count === 0) continue
      const statusOids = Array.from({ length: count }, (_, i) =>
        oid.at(oid.RECEIVING_CARD_TEMPERATURE_STATUS, card, port, i + 1)
      )
      let statuses = new Map<string, string | number | null>()
      try {
        statuses = await session.get(statusOids)
      } catch {
        // The count is still worth having: "eight cards on port 2" without
        // their temperature status beats showing the port as empty.
      }
      for (let index = 1; index <= count; index++) {
        const status = asNumber(
          statuses.get(oid.at(oid.RECEIVING_CARD_TEMPERATURE_STATUS, card, port, index))
        )
        cabinets.push({
          id: `${card}.${port}.${index}`,
          screen: `port ${port}`,
          online: true,
          ...(status !== undefined
            ? { tempStatus: status === oid.ABNORMAL ? ('abnormal' as const) : ('normal' as const) }
            : {}),
        })
      }
    }
  }
  return cabinets
}
