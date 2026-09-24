import { describe, expect, it, vi } from 'vitest'
import type { KnownEvent } from './eventScope.ts'
import {
  checkMove,
  checkPoster,
  eventKeyFrom,
  proveBox,
  type Proof,
  type ProveDeps,
} from './identity.ts'

/**
 * A phone checking a box against the key it kept, with WebCrypto, as the
 * apps do. The box here is stood in for by a key pair and the statement as
 * docs/DISCOVERY.md writes it out; server/test/identity.test.ts checks the
 * real box against the same statement.
 */

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

/** A box with a key of its own, answering the way server/src/app.ts does. */
async function aBox() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const key = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  const sign = async (eventId: string, host: string, nonce: string) =>
    b64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          new TextEncoder().encode(`crewbox-identity-v1\n${eventId}\n${host}\n${nonce}`)
        )
      )
    )
  return { key, sign }
}

type Box = Awaited<ReturnType<typeof aBox>>

/**
 * Whatever answers at the address the phone asks. By default the box, for
 * the address it was asked at; `answer` stands in for anything else.
 */
function reaching(
  box: Box,
  answer?: (asked: { host: string; nonce: string }) => Promise<Response> | Response
) {
  const asked: URL[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    asked.push(url)
    const nonce = url.searchParams.get('nonce') ?? ''
    if (answer) return answer({ host: url.host, nonce })
    return Response.json({
      eventId: 'friday',
      key: box.key,
      signature: await box.sign('friday', url.host, nonce),
    })
  })
  return { asked, deps: { fetch: fetch as unknown as typeof globalThis.fetch } satisfies ProveDeps }
}

const ORIGIN = 'http://10.0.0.66:8787'

describe('proving a box', () => {
  it('is proven when the box signs for this event, this address and this challenge', async () => {
    const box = await aBox()
    const { asked, deps } = reaching(box)
    expect(await proveBox(ORIGIN, { id: 'friday', key: box.key }, deps)).toEqual({
      kind: 'proven',
    })
    expect(asked).toHaveLength(1)
    expect(`${asked[0]!.origin}${asked[0]!.pathname}`).toBe(`${ORIGIN}/api/identity`)
    // 32 random bytes, base64url, as the box takes them.
    expect(asked[0]!.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('asks with a fresh challenge every time', async () => {
    const box = await aBox()
    const { asked, deps } = reaching(box)
    await proveBox(ORIGIN, { id: 'friday', key: box.key }, deps)
    await proveBox(ORIGIN, { id: 'friday', key: box.key }, deps)
    expect(asked[0]!.searchParams.get('nonce')).not.toBe(asked[1]!.searchParams.get('nonce'))
  })

  it('signs for the address as the phone connected to it, default port and all', async () => {
    const box = await aBox()
    for (const origin of ['http://10.0.0.5', 'https://crew.example.com', 'http://[fe80::1]:8787']) {
      const hosts: string[] = []
      const { deps } = reaching(box, async ({ host, nonce }) => {
        hosts.push(host)
        return Response.json({
          eventId: 'friday',
          key: box.key,
          signature: await box.sign('friday', new URL(origin).host, nonce),
        })
      })
      expect(await proveBox(origin, { id: 'friday', key: box.key }, deps), origin).toEqual({
        kind: 'proven',
      })
    }
  })

  it('is refused for an answer signed with another key, which it offers instead', async () => {
    const kept = await aBox()
    const other = await aBox()
    const { deps } = reaching(other)
    expect(await proveBox(ORIGIN, { id: 'friday', key: kept.key }, deps)).toEqual({
      kind: 'refused',
      reason: 'signature',
      key: other.key,
    })
  })

  it('is refused for the real box’s answer passed on by a relay at another address', async () => {
    const box = await aBox()
    // The relay asks the box at its own address, which is all the box signs.
    const { deps } = reaching(box, async ({ nonce }) =>
      Response.json({
        eventId: 'friday',
        key: box.key,
        signature: await box.sign('friday', '10.0.0.5:8787', nonce),
      })
    )
    expect(await proveBox(ORIGIN, { id: 'friday', key: box.key }, deps)).toMatchObject({
      kind: 'refused',
      reason: 'signature',
    })
  })

  it('is refused for an answer to another challenge, or for another event', async () => {
    const box = await aBox()
    const stale = await box.sign('friday', new URL(ORIGIN).host, 'A'.repeat(43))
    const replayed = reaching(box, () =>
      Response.json({ eventId: 'friday', key: box.key, signature: stale })
    )
    expect(await proveBox(ORIGIN, { id: 'friday', key: box.key }, replayed.deps)).toMatchObject({
      kind: 'refused',
      reason: 'signature',
    })
    const another = reaching(box, async ({ host, nonce }) =>
      Response.json({
        eventId: 'saturday',
        key: box.key,
        signature: await box.sign('saturday', host, nonce),
      })
    )
    expect(await proveBox(ORIGIN, { id: 'friday', key: box.key }, another.deps)).toMatchObject({
      kind: 'refused',
      reason: 'another-event',
    })
  })

  it('is refused for an answer that is not one, offering no key', async () => {
    const box = await aBox()
    for (const body of [
      {},
      { eventId: 'friday', key: 'not a key', signature: 'short' },
      { eventId: 'friday', key: box.key, signature: `${'A'.repeat(85)}=` },
      // The right length, and nothing a key signed: zeros, and not a string.
      { eventId: 'friday', key: box.key, signature: 'A'.repeat(86) },
      { eventId: 'friday', key: box.key, signature: 42 },
    ]) {
      const { deps } = reaching(box, () => Response.json(body))
      const proof = await proveBox(ORIGIN, { id: 'friday', key: box.key }, deps)
      expect(proof.kind, JSON.stringify(body)).toBe('refused')
      if (body.key !== box.key) expect(proof).not.toHaveProperty('key')
    }
    const { deps } = reaching(box, () => new Response('<html>', { status: 200 }))
    expect(await proveBox(ORIGIN, { id: 'friday', key: box.key }, deps)).toMatchObject({
      kind: 'unchecked',
      reason: 'unreachable',
    })
  })

  it('is unchecked when there is nothing to check with, or no answer to check', async () => {
    const box = await aBox()
    const { deps, asked } = reaching(box)
    expect(await proveBox(ORIGIN, { id: 'friday' }, deps)).toEqual({
      kind: 'unchecked',
      reason: 'no-key',
    })
    // Not a point on the curve: nothing this code would have kept.
    const notAPoint = b64url(new Uint8Array(65).fill(4))
    expect(await proveBox(ORIGIN, { id: 'friday', key: notAPoint }, deps)).toEqual({
      kind: 'unchecked',
      reason: 'no-key',
    })
    // A browser on a plain-HTTP page has no WebCrypto.
    expect(
      await proveBox(ORIGIN, { id: 'friday', key: box.key }, { ...deps, subtle: undefined })
    ).toEqual({ kind: 'unchecked', reason: 'no-crypto' })
    expect(asked).toHaveLength(0)

    for (const [status, reason] of [
      [404, 'too-old'],
      [421, 'misdirected'],
      [500, 'unreachable'],
    ] as const) {
      const { deps } = reaching(box, () => new Response('{}', { status }))
      expect(await proveBox(ORIGIN, { id: 'friday', key: box.key }, deps)).toEqual({
        kind: 'unchecked',
        reason,
      })
    }
    const { deps: gone } = reaching(box, () => Promise.reject(new TypeError('Failed to fetch')))
    expect(await proveBox(ORIGIN, { id: 'friday', key: box.key }, gone)).toEqual({
      kind: 'unchecked',
      reason: 'unreachable',
    })
  })
})

describe('an event’s key', () => {
  it('is a P-256 point as a box gives it, and nothing else', async () => {
    const { key } = await aBox()
    expect(eventKeyFrom(key)).toBe(key)
    for (const bad of [undefined, 42, '', key.slice(1), `${key}A`, `${key.slice(1)}+`]) {
      expect(eventKeyFrom(bad)).toBeUndefined()
    }
  })
})

describe('a move', () => {
  const held: Record<string, KnownEvent> = {
    friday: { id: 'friday', name: 'Harbour Fest', origin: 'http://10.0.0.5:8787', seenAt: 1 },
    unplaced: { id: 'unplaced', name: '', origin: '', seenAt: 0 },
  }
  const prove = vi.fn(async () => ({ kind: 'proven' }) as const)
  const heldAs = (id: string) => held[id]

  it('is not one for an event this phone does not hold, or holds at that address', async () => {
    expect(await checkMove('saturday', ORIGIN, prove, heldAs)).toBeNull()
    expect(await checkMove('friday', 'http://10.0.0.5:8787', prove, heldAs)).toBeNull()
    expect(await checkMove('unplaced', ORIGIN, prove, heldAs)).toBeNull()
    expect(prove).not.toHaveBeenCalled()
  })

  it('asks the box at the new address to prove it, against the event as held', async () => {
    expect(await checkMove('friday', ORIGIN, prove, heldAs)).toEqual({ kind: 'proven' })
    expect(prove).toHaveBeenCalledWith(ORIGIN, held.friday)
  })
})

describe('a poster’s box', () => {
  /** What the box at the poster's address answers, as proveBox reads it. */
  const answers = (proof: Proof) => vi.fn(async () => proof)
  const nothingHeld = () => undefined

  it('is the poster’s once it signs for the poster’s event, this address and a fresh challenge', async () => {
    const box = await aBox()
    const { asked, deps } = reaching(box)
    const prove: typeof proveBox = (origin, event) => proveBox(origin, event, deps)
    const poster = { id: 'friday', key: box.key }
    expect(await checkPoster(ORIGIN, poster, prove, nothingHeld)).toBe('proven')
    expect(`${asked[0]!.origin}${asked[0]!.pathname}`).toBe(`${ORIGIN}/api/identity`)
    // Another box at that address, the real one's answer passed on, or the
    // poster's box for another event: none of them is the poster's.
    const other = await aBox()
    expect(await checkPoster(ORIGIN, { id: 'friday', key: other.key }, prove, nothingHeld)).toBe(
      'refused'
    )
    expect(await checkPoster(ORIGIN, { id: 'saturday', key: box.key }, prove, nothingHeld)).toBe(
      'refused'
    )
  })

  it('is not the poster’s when it can’t sign at all, which the poster’s box can', async () => {
    for (const reason of ['too-old', 'no-key'] as const) {
      const prove = answers({ kind: 'unchecked', reason })
      expect(
        await checkPoster(ORIGIN, { id: 'friday', key: 'k' }, prove, nothingHeld),
        reason
      ).toBe('refused')
    }
    for (const reason of ['another-event', 'signature'] as const) {
      const prove = answers({ kind: 'refused', reason })
      expect(
        await checkPoster(ORIGIN, { id: 'friday', key: 'k' }, prove, nothingHeld),
        reason
      ).toBe('refused')
    }
  })

  it('is left to the sign-in when it won’t sign for a name, or can’t be checked here', async () => {
    // By a name over plain HTTP, or through a tunnel, a box never signs.
    const misdirected = answers({ kind: 'unchecked', reason: 'misdirected' })
    for (const origin of ['http://crewbox.local:8787', 'https://chat.crew.example']) {
      expect(await checkPoster(origin, { id: 'friday', key: 'k' }, misdirected, nothingHeld)).toBe(
        'unchecked'
      )
    }
    const noCrypto = answers({ kind: 'unchecked', reason: 'no-crypto' })
    expect(await checkPoster(ORIGIN, { id: 'friday', key: 'k' }, noCrypto, nothingHeld)).toBe(
      'unchecked'
    )
    const prove = answers({ kind: 'unchecked', reason: 'unreachable' })
    expect(await checkPoster(ORIGIN, { id: 'friday', key: 'k' }, prove, nothingHeld)).toBe(
      'unreachable'
    )
  })

  it('is not the poster’s when it won’t sign for the IP address it was reached at', async () => {
    // Which the poster's box, reached there, does: anything else can say
    // it won't, and the PIN isn't sent on its say-so.
    const misdirected = answers({ kind: 'unchecked', reason: 'misdirected' })
    for (const origin of [ORIGIN, 'http://192.168.8.1', 'http://[fd00::8]:8787']) {
      expect(
        await checkPoster(origin, { id: 'friday', key: 'k' }, misdirected, nothingHeld),
        origin
      ).toBe('refused')
    }
  })

  it('isn’t asked when this device holds the poster’s event with another key', async () => {
    const kept = await aBox()
    const printed = await aBox()
    const held = (key?: string) => (id: string) =>
      ({
        id,
        name: 'Harbour Fest',
        origin: 'http://10.0.0.5:8787',
        seenAt: 1,
        ...(key ? { key } : {}),
      }) satisfies KnownEvent
    const prove = answers({ kind: 'proven' })
    expect(
      await checkPoster(ORIGIN, { id: 'friday', key: printed.key }, prove, held(kept.key))
    ).toBe('kept-another')
    expect(prove).not.toHaveBeenCalled()
    // The key it kept, or none kept: the box is asked, with the poster's.
    for (const key of [printed.key, undefined]) {
      const poster = { id: 'friday', key: printed.key }
      expect(await checkPoster(ORIGIN, poster, prove, held(key))).toBe('proven')
      expect(prove).toHaveBeenLastCalledWith(ORIGIN, poster)
    }
  })
})
