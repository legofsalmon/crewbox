import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto'

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

/** What is signed: the context, the event, and the phone's challenge, a line each. */
export function identityStatement(eventId: string, nonce: string): Buffer {
  return Buffer.from(`${IDENTITY_CONTEXT}\n${eventId}\n${nonce}`, 'utf8')
}

export interface BoxIdentity {
  /**
   * The public key as the uncompressed point (0x04, then x and y, 65 bytes),
   * base64url: what WebCrypto imports as `raw` for ECDSA P-256.
   */
  readonly publicKey: string
  /** The answer to a phone's challenge, for the event this box runs. */
  sign(eventId: string, nonce: string): string
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
    sign: (eventId, nonce) =>
      sign('sha256', identityStatement(eventId, nonce), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url'),
  }
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
