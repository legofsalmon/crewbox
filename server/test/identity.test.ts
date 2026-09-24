import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type App } from '../src/app.ts'
import { openDb } from '../src/db.ts'
import { boxIdentity, IDENTITY_SETTING, NONCE_RE } from '../src/identity.ts'
import { Store } from '../src/store.ts'

/**
 * The box's signing key, checked the way a phone will check it: with
 * WebCrypto, the API the apps have, against the key the phone kept.
 *
 * The statement is written out here rather than imported from the box,
 * because it is a contract with phones already in the field: a change to
 * what the box signs has to fail this test, not follow it silently.
 */

const statement = (eventId: string, nonce: string): Uint8Array =>
  new TextEncoder().encode(`crewbox-identity-v1\n${eventId}\n${nonce}`)

/** What a phone does with a box's answer. */
async function phoneAccepts(
  keptKey: string,
  eventId: string,
  nonce: string,
  signature: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(keptKey, 'base64url'),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(signature, 'base64url'),
    statement(eventId, nonce)
  )
}

const challenge = (bytes = 32): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')

/** A settings table and nothing else, as the key sees the store. */
function settings() {
  const rows = new Map<string, string>()
  return {
    rows,
    getSetting: (key: string) => rows.get(key),
    setSetting: (key: string, value: string) => void rows.set(key, value),
  }
}

function warnings() {
  const said: string[] = []
  return { said, warn: (message: string) => void said.push(message) }
}

describe("the box's signing key", () => {
  it('is minted once, into the settings table, and kept', () => {
    const store = settings()
    const first = boxIdentity(store)
    expect(store.rows.get(IDENTITY_SETTING)).toMatch(/^-----BEGIN PRIVATE KEY-----\n/)
    expect(boxIdentity(store).publicKey).toBe(first.publicKey)
  })

  it('is published as the uncompressed P-256 point WebCrypto imports as raw', async () => {
    const { publicKey } = boxIdentity(settings())
    const point = Buffer.from(publicKey, 'base64url')
    expect(point).toHaveLength(65)
    expect(point[0]).toBe(0x04)
    await expect(
      crypto.subtle.importKey('raw', point, { name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'verify',
      ])
    ).resolves.toBeDefined()
  })

  it('answers a challenge so that the key a phone kept accepts it', async () => {
    const box = boxIdentity(settings())
    const nonce = challenge()
    const signature = box.sign('evt_one', nonce)
    // r and s end to end, which is what WebCrypto takes; DER would be 70-72.
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64)
    expect(await phoneAccepts(box.publicKey, 'evt_one', nonce, signature)).toBe(true)
  })

  it('answers for its own event and this challenge only', async () => {
    const box = boxIdentity(settings())
    const nonce = challenge()
    const signature = box.sign('evt_one', nonce)
    expect(await phoneAccepts(box.publicKey, 'evt_two', nonce, signature)).toBe(false)
    expect(await phoneAccepts(box.publicKey, 'evt_one', challenge(), signature)).toBe(false)
  })

  it('is its own for every database, so another box cannot answer for it', async () => {
    const ours = boxIdentity(settings())
    const theirs = boxIdentity(settings())
    expect(theirs.publicKey).not.toBe(ours.publicKey)
    const nonce = challenge()
    expect(
      await phoneAccepts(ours.publicKey, 'evt_one', nonce, theirs.sign('evt_one', nonce))
    ).toBe(false)
  })

  it('replaces a stored key that will not read, and says so', async () => {
    const store = settings()
    store.rows.set(IDENTITY_SETTING, 'not a key at all')
    const log = warnings()
    const box = boxIdentity(store, log)
    expect(log.said).toHaveLength(1)
    expect(log.said[0]).toMatch(/would not read as P-256/)
    expect(store.rows.get(IDENTITY_SETTING)).toMatch(/^-----BEGIN PRIVATE KEY-----\n/)
    // And the new one is kept: the next start says nothing.
    const again = warnings()
    expect(boxIdentity(store, again).publicKey).toBe(box.publicKey)
    expect(again.said).toEqual([])
    const nonce = challenge()
    expect(await phoneAccepts(box.publicKey, 'evt_one', nonce, box.sign('evt_one', nonce))).toBe(
      true
    )
  })

  it('replaces a key that is not P-256', () => {
    for (const other of [
      generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey,
      generateKeyPairSync('ed25519').privateKey,
    ]) {
      const store = settings()
      const pem = other.export({ type: 'pkcs8', format: 'pem' }) as string
      store.rows.set(IDENTITY_SETTING, pem)
      const log = warnings()
      const box = boxIdentity(store, log)
      expect(log.said).toHaveLength(1)
      expect(store.rows.get(IDENTITY_SETTING)).not.toBe(pem)
      expect(Buffer.from(box.publicKey, 'base64url')).toHaveLength(65)
    }
  })

  it('takes a challenge of 16 to 64 base64url bytes, and nothing that could break a line', () => {
    expect(NONCE_RE.test(challenge(16))).toBe(true)
    expect(NONCE_RE.test(challenge(64))).toBe(true)
    expect(NONCE_RE.test(challenge(15))).toBe(false)
    expect(NONCE_RE.test(challenge(65))).toBe(false)
    const ok = challenge(24)
    for (const bad of [`${ok}\n`, `${ok}\nevt_other`, `${ok}=`, `${ok}+`, `${ok}/`, `${ok}.`, '']) {
      expect(NONCE_RE.test(bad)).toBe(false)
    }
  })
})

describe('over HTTP', () => {
  let dir: string
  let db: DatabaseSync
  let store: Store
  let app: App

  const build = (): App =>
    buildApp({ store, eventPin: '4242', filesDir: dir, dataDir: dir, logger: false })

  beforeEach(() => {
    dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-identity-'))
    db = openDb(':memory:')
    store = new Store(db)
    store.createChannel('general', 'public', 'Everyone')
    app = build()
  })

  afterEach(async () => {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const config = async () =>
    (await app.inject({ method: 'GET', url: '/api/config' })).json() as {
      eventId: string
      eventKey: string
    }

  it('publishes the key before sign-in, and answers a challenge with it', async () => {
    const { eventId, eventKey } = await config()
    expect(Buffer.from(eventKey, 'base64url')).toHaveLength(65)

    const nonce = challenge()
    const res = await app.inject({ method: 'GET', url: `/api/identity?nonce=${nonce}` })
    expect(res.statusCode).toBe(200)
    const answer = res.json() as { eventId: string; key: string; signature: string }
    expect(answer.eventId).toBe(eventId)
    expect(answer.key).toBe(eventKey)
    // Checked against the key the phone kept from /api/config, not the one
    // in the answer, which is how a phone must check it.
    expect(await phoneAccepts(eventKey, eventId, nonce, answer.signature)).toBe(true)
  })

  it('hands the key over with the token when a phone joins, and again when it signs back in', async () => {
    const { eventKey } = await config()
    const join = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/join',
          payload: { name: 'Maya', eventPin: '4242', personalPin: '1234' },
        })
      ).json() as { created: boolean; eventKey: string }
    const first = await join()
    expect(first.created).toBe(true)
    expect(first.eventKey).toBe(eventKey)
    const again = await join()
    expect(again.created).toBe(false)
    expect(again.eventKey).toBe(eventKey)
  })

  it('refuses a challenge that is not 16 to 64 random bytes, base64url', async () => {
    const ok = challenge(24)
    for (const query of [
      '',
      '?nonce=',
      `?nonce=${challenge(8)}`,
      `?nonce=${challenge(65)}`,
      `?nonce=${ok}%0Aevt_other`,
      `?nonce=${ok}%2F`,
      `?nonce=${ok}&nonce=${ok}`,
    ]) {
      const res = await app.inject({ method: 'GET', url: `/api/identity${query}` })
      expect(res.statusCode, query).toBe(400)
    }
  })

  it('is the same box after a restart on the same database', async () => {
    const before = await config()
    await app.close()
    app = build()
    expect(await config()).toMatchObject(before)
  })
})
