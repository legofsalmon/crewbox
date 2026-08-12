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
import { GET_REQUEST, GET_RESPONSE } from '../src/video/snmp.ts'

/**
 * A fake SNMP agent, shared by the codec tests and the watcher tests.
 *
 * It answers a real GetRequest with a real GetResponse, built with the same
 * encoders the reader uses. That is a weaker check than a second independent
 * implementation would be — but the codec tests in `videoBer.test.ts` pin the
 * byte layout against hand-written expectations, so this file only has to be
 * a plausible agent, not an oracle.
 */

/** noSuchObject: the agent has nothing at that OID. A normal answer. */
const NO_SUCH_OBJECT = 0x80

export interface AgentReply {
  packet: Buffer
  /** Every OID this request asked for, in order. */
  asked: string[]
}

/** Build the response to `request` from `table`. Returns null if it isn't a GET. */
export function respondTo(
  request: Buffer,
  table: Record<string, string | number>,
  community = 'public'
): AgentReply | null {
  const message = readTlv(request, 0)
  const [, , pdu] = readSequence(message.value)
  if (pdu.tag !== GET_REQUEST) return null

  const [id, , , list] = readSequence(pdu.value)
  const requestId = decodeInteger(id.value)
  const asked: string[] = []
  const varbinds: Buffer[] = []

  for (const entry of readSequence(list.value)) {
    const [name] = readSequence(entry.value)
    const oid = decodeOid(name.value)
    asked.push(oid)
    const value = table[oid]
    const encoded =
      value === undefined
        ? encodeTlv(NO_SUCH_OBJECT, Buffer.alloc(0))
        : typeof value === 'number'
          ? encodeInteger(value)
          : encodeOctetString(value)
    varbinds.push(encodeTlv(TAG_SEQUENCE, Buffer.concat([encodeOid(oid), encoded])))
  }

  const responsePdu = encodeTlv(
    GET_RESPONSE,
    Buffer.concat([
      encodeInteger(requestId),
      encodeInteger(0),
      encodeInteger(0),
      encodeTlv(TAG_SEQUENCE, Buffer.concat(varbinds)),
    ])
  )
  return {
    packet: encodeTlv(
      TAG_SEQUENCE,
      Buffer.concat([encodeInteger(1), encodeOctetString(community), responsePdu])
    ),
    asked,
  }
}
