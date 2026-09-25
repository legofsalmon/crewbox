import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'

/**
 * The box's signing key: how a phone that has joined an event before tells
 * that event's box from anything else at an address.
 *
 * An event ID is public. The join screen, `/api/config` and the announcement
 * on the crew network all say it, so anything on the Wi-Fi can claim one.
 * What nothing else can do is sign with the key the phone was given when it
 * first joined. So a phone that finds its event somewhere new (the box moved
 * to another adapter or port, or a spare restored from last night's backup
 * took over) sends a random challenge, checks the answer against the key it
 * kept, and follows the event there only if it holds (docs/DISCOVERY.md).
 *
 * Kept in the settings table beside the event's ID, which is the point: a
 * backup carries both, so a spare restored from one proves itself as this
 * box, while a spare started with a fresh database mints its own ID and key
 * and is a different event to every phone, as it already was.
 *
 * P-256 ECDSA with SHA-256, because every browser engine's WebCrypto can
 * check it, WebKit's included. The signature is IEEE P1363, the 64 bytes of
 * r and s end to end that WebCrypto verifies, not the DER Node writes unless
 * told otherwise.
 *
 * What is signed includes the address the phone asked at, and the box signs
 * only for an address that is its own ({@link hostToSign}). Without that,
 * anything on the Wi-Fi could announce a phone's event at its own address,
 * pass the phone's challenge on to the real box and the answer back, and
 * stand between the phone and its box from then on.
 */

/** The settings row that holds the private key. Reaches real boxes: do not rename it. */
export const IDENTITY_SETTING = 'identityKey'

/**
 * What every signature starts with, so this key signs identity answers and
 * nothing else: whatever else a box signs one day, a challenge can't be
 * made to produce it.
 */
export const IDENTITY_CONTEXT = 'crewbox-identity-v1'

/**
 * A phone's challenge: 16 to 64 random bytes, base64url. Nothing else, so a
 * challenge can't carry a line break into the signed statement.
 */
export const NONCE_RE = /^[A-Za-z0-9_-]{22,86}$/

/**
 * What is signed: the context, the event, the address the phone asked at (the
 * Host header, in lower case) and the phone's challenge, a line each.
 */
export function identityStatement(eventId: string, host: string, nonce: string): Buffer {
  return Buffer.from(`${IDENTITY_CONTEXT}\n${eventId}\n${host}\n${nonce}`, 'utf8')
}

/**
 * A Host header this box might sign: an IPv4 address or a name, or an IPv6
 * address in brackets, then a port if it has one. Lower case by the time it
 * is tested, and nothing that could break a line.
 */
const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::\d{1,5})?$/

/** Where a request arrived: the address it was sent to, and whether over TLS. */
export interface Arrival {
  readonly localAddress?: string | undefined
  readonly tls: boolean
}

export type HostCheck =
  { readonly host: string } | { readonly status: 400 | 421; readonly error: string }

/**
 * The address a phone asked at, as the box signs it, or why it won't.
 *
 * The phone checks the signature over the address it connected to, so the
 * box must never sign for an address that isn't its own. A relay can put
 * anything in the Host header; what it can't do is change where its own
 * connection arrived, or answer TLS for a name it has no certificate for. So
 * the box signs for
 *
 * - an IP address only when it is the one this connection arrived at,
 * - `localhost` only when the connection came over loopback, from this
 *   machine, and
 * - a name only when it is on the certificate this connection was served
 *   with.
 *
 * Anything else is 421, Misdirected Request. That includes a box reached
 * through a port forward, and one asked by a name over plain HTTP: a relay
 * could ask by any name it liked, so no name proves anything without TLS. A
 * phone treats a 421 as a box it cannot check (docs/DISCOVERY.md).
 */
export function hostToSign(
  header: string | undefined,
  arrival: Arrival,
  certNames: readonly string[]
): HostCheck {
  const host = header?.toLowerCase() ?? ''
  const name = HOST_RE.exec(host)?.[1]
  if (!name) {
    return { status: 400, error: 'the Host header must be an address or a name, and a port' }
  }
  const at = arrival.localAddress ? plainAddress(arrival.localAddress) : undefined
  if (name.startsWith('[')) {
    const address = name.slice(1, -1)
    if (!isIPv6(address)) return { status: 400, error: 'the Host header has a malformed address' }
    if (at !== undefined && plainAddress(address) === at) return { host }
  } else if (isIPv4(name)) {
    if (name === at) return { host }
  } else if (name === 'localhost') {
    if (at !== undefined && (at === '::1' || at.startsWith('127.'))) return { host }
  } else if (arrival.tls && certNames.some((certName) => certName.toLowerCase() === name)) {
    return { host }
  }
  return {
    status: 421,
    error:
      'this box answers only for the address it was reached at, localhost from itself, ' +
      'and the names on its certificate',
  }
}

/**
 * An address as one string per address: no zone, an IPv4 address that
 * arrived on a dual-stack socket as itself, and IPv6 in its shortest form.
 */
function plainAddress(address: string): string {
  const unzoned = address.replace(/%.*$/, '').toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(unzoned)?.[1]
  if (mapped) return mapped
  return isIPv6(unzoned) ? new URL(`http://[${unzoned}]/`).hostname.slice(1, -1) : unzoned
}

export interface BoxIdentity {
  /**
   * The public key as the uncompressed point (0x04, then x and y, 65 bytes),
   * base64url: what WebCrypto imports as `raw` for ECDSA P-256.
   */
  readonly publicKey: string
  /**
   * The answer to a phone's challenge, for the event this box runs and the
   * address it was asked at, which the caller has checked is this box's.
   */
  sign(eventId: string, host: string, nonce: string): string
}

interface SettingsStore {
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
}

interface Log {
  warn(message: string): void
}

/**
 * This box's identity: the key in its database, or one minted and written
 * there when it has none.
 *
 * A stored key that won't read as P-256 is replaced, and the box says so
 * once. It could prove nothing anyway, and phones that kept its public key
 * will now ask before following this box, which is the truth.
 */
export function boxIdentity(store: SettingsStore, log?: Log): BoxIdentity {
  const privateKey = storedKey(store, log) ?? mint(store)
  const publicKey = uncompressedPoint(createPublicKey(privateKey))
  return {
    publicKey,
    sign: (eventId, host, nonce) =>
      lowS(
        sign('sha256', identityStatement(eventId, host, nonce), {
          key: privateKey,
          dsaEncoding: 'ieee-p1363',
        })
      ).toString('base64url'),
  }
}

/** P-256's group order. */
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

/**
 * The same signature with s in the lower half of the group. For every
 * ECDSA signature (r, s), (r, n - s) is one too, and a verifier that insists
 * on one form of each insists on the lower. WebCrypto takes either, so this
 * costs nothing today, and a check written later outside a browser can't
 * then fail on half the answers.
 */
function lowS(p1363: Buffer): Buffer {
  const s = BigInt(`0x${p1363.subarray(32).toString('hex')}`)
  if (s <= P256_N >> 1n) return p1363
  const low = Buffer.from((P256_N - s).toString(16).padStart(64, '0'), 'hex')
  return Buffer.concat([p1363.subarray(0, 32), low])
}

function storedKey(store: SettingsStore, log?: Log): KeyObject | undefined {
  const stored = store.getSetting(IDENTITY_SETTING)
  if (!stored) return undefined
  try {
    const key = createPrivateKey(stored)
    if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') {
      return key
    }
  } catch {
    // Not a key at all; replaced below, as one on another curve is.
  }
  log?.warn(
    'identity: the signing key in the database would not read as P-256, so the box has a new ' +
      'one. Phones that joined before will ask before following this box to a new address.'
  )
  return undefined
}

function mint(store: SettingsStore): KeyObject {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  store.setSetting(IDENTITY_SETTING, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)
  return privateKey
}

/**
 * The last 65 bytes of P-256's SubjectPublicKeyInfo, which is always 91
 * bytes long and ends with the point uncompressed.
 */
function uncompressedPoint(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const point = spki.subarray(spki.length - 65)
  if (spki.length !== 91 || point[0] !== 0x04) {
    throw new Error('identity: a P-256 public key did not export as an uncompressed point')
  }
  return point.toString('base64url')
}
