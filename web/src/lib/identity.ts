import { knownEvent, type KnownEvent } from './eventScope.ts'

/**
 * Whether a box at an address is the one this device knows an event by
 * (docs/DISCOVERY.md, "How a box proves which event it is").
 *
 * An event's ID is public, and a box saying it runs one is only saying so.
 * What only that event's box can do is sign a fresh challenge with the key
 * this device kept when it joined, for the address this device asked at. A
 * backup carries the key, so a spare restored from one passes; anything else
 * fails, a relay passing the challenge on to the real box from an address of
 * its own included.
 *
 * Checked with WebCrypto, which both apps have: their pages are secure
 * contexts. A browser on a plain-HTTP box has no `crypto.subtle` and can
 * check nothing, which it never needs to: a browser is at its box's address,
 * and has no other to move an event to.
 */

/** What every statement a box signs starts with. */
const CONTEXT = 'crewbox-identity-v1'

/** A challenge's length in bytes: the box takes 16 to 64. */
const CHALLENGE_BYTES = 32

/** How long a box has to answer. The same as asking one which event it runs. */
const ANSWER_MS = 6000

/**
 * An event's public key as a box gives it, if it is one: a P-256 point,
 * uncompressed (65 bytes), base64url.
 */
export function eventKeyFrom(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{87}$/.test(value) ? value : undefined
}

export type Proof =
  /** It signed for this event, this address and this challenge, with the key kept. */
  | { kind: 'proven' }
  /**
   * It answered, and did not prove it: it said it runs another event, or
   * its signature is not the kept key's for this address. `key` is the one
   * it offered instead, for somebody who opens it anyway.
   */
  | { kind: 'refused'; reason: 'another-event' | 'signature'; key?: string }
  /**
   * Nothing to check it with, or it could not be checked: no key kept, no
   * WebCrypto, no answer, a box too old to sign (404), or one that will not
   * sign for the address it was asked at (421), as behind a port forward.
   */
  | {
      kind: 'unchecked'
      reason: 'no-key' | 'no-crypto' | 'unreachable' | 'too-old' | 'misdirected'
    }

export interface ProveDeps {
  fetch?: typeof fetch
  subtle?: SubtleCrypto | undefined
  random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>
}

/** Ask the box at `origin` to prove it is `event`'s, against the key kept for it. */
export async function proveBox(
  origin: string,
  event: Pick<KnownEvent, 'id' | 'key'>,
  deps: ProveDeps = {}
): Promise<Proof> {
  const get = deps.fetch ?? globalThis.fetch
  // Given as undefined, it is a page without WebCrypto, as a browser on a
  // plain-HTTP box is.
  const subtle = 'subtle' in deps ? deps.subtle : globalThis.crypto?.subtle
  const random = deps.random ?? ((bytes) => globalThis.crypto.getRandomValues(bytes))
  const kept = eventKeyFrom(event.key)
  if (!kept) return { kind: 'unchecked', reason: 'no-key' }
  if (!subtle) return { kind: 'unchecked', reason: 'no-crypto' }
  let key: CryptoKey
  try {
    key = await subtle.importKey(
      'raw',
      fromBase64url(kept),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    )
  } catch {
    // Not a point on the curve: kept by something other than this code.
    return { kind: 'unchecked', reason: 'no-key' }
  }

  const challenge = toBase64url(random(new Uint8Array(CHALLENGE_BYTES)))
  // What the phone connected to, as its Host header says it: the box signs
  // that, and only when it is the box's own.
  const host = new URL(origin).host
  let answer: unknown
  try {
    const res = await get(`${origin}/api/identity?nonce=${challenge}`, {
      signal: AbortSignal.timeout(ANSWER_MS),
    })
    if (res.status === 404) return { kind: 'unchecked', reason: 'too-old' }
    if (res.status === 421) return { kind: 'unchecked', reason: 'misdirected' }
    if (!res.ok) return { kind: 'unchecked', reason: 'unreachable' }
    answer = await res.json()
  } catch {
    return { kind: 'unchecked', reason: 'unreachable' }
  }

  const { eventId, key: offered, signature } = (answer ?? {}) as Record<string, unknown>
  const refused = (reason: 'another-event' | 'signature'): Proof => {
    const other = eventKeyFrom(offered)
    return other ? { kind: 'refused', reason, key: other } : { kind: 'refused', reason }
  }
  if (eventId !== event.id) return refused('another-event')
  // Anything but the kept key's signature over this statement fails to
  // verify, whatever its shape, and one that won't decode throws.
  if (typeof signature !== 'string') return refused('signature')
  const statement = new TextEncoder().encode(`${CONTEXT}\n${event.id}\n${host}\n${challenge}`)
  let verified: boolean
  try {
    verified = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      fromBase64url(signature),
      statement
    )
  } catch {
    // Not base64url at all.
    verified = false
  }
  return verified ? { kind: 'proven' } : refused('signature')
}

/**
 * Whether taking an event this device holds to the box at `origin` would be
 * a move, and if so what that box proves.
 *
 * Null when it is not a move: an event this device does not hold, or holds
 * at that very address, or has no address for. Otherwise the proof, which
 * the caller weighs: a move nobody asked for goes ahead only when it is
 * proven, and one to an address somebody typed goes ahead unless it is
 * refused, since the address was theirs to give.
 */
export async function checkMove(
  eventId: string,
  origin: string,
  prove: typeof proveBox = proveBox,
  heldAs: (id: string) => KnownEvent | undefined = knownEvent
): Promise<Proof | null> {
  const held = heldAs(eventId)
  if (!held?.origin || held.origin === origin) return null
  return prove(origin, held)
}

function toBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
