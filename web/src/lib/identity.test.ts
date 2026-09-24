import { describe, expect, it, vi } from 'vitest'
import type { KnownEvent } from './eventScope.ts'
import { checkMove, eventKeyFrom, proveBox, type ProveDeps } from './identity.ts'

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
