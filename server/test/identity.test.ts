import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, mirrorOnLoopback, type App } from '../src/app.ts'
import { lanIps } from '../src/box.ts'
import { openDb } from '../src/db.ts'
import { boxIdentity, hostToSign, IDENTITY_SETTING, NONCE_RE } from '../src/identity.ts'
import { Store } from '../src/store.ts'
import { CERT_FILE, KEY_FILE, loadTls } from '../src/tls.ts'

/**
 * The box's signing key, checked the way a phone will check it: with
 * WebCrypto, the API the apps have, against the key the phone kept and the
 * address the phone connected to.
 *
 * The statement is written out here rather than imported from the box,
 * because it is a contract with the apps: a change to what the box signs has
 * to fail this test, not follow it silently.
 */

const statement = (eventId: string, host: string, nonce: string): Uint8Array =>
  new TextEncoder().encode(`crewbox-identity-v1\n${eventId}\n${host}\n${nonce}`)

/** What a phone does with a box's answer, having connected to `host`. */
async function phoneAccepts(
  keptKey: string,
  eventId: string,
  host: string,
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
    statement(eventId, host, nonce)
  )
}

const challenge = (bytes = 32): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')

/** Where the unit tests say a phone connected. */
const HOST = '10.0.0.5:8787'

/** P-256's group order, written out. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

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
    const signature = box.sign('evt_one', HOST, nonce)
    // r and s end to end, which is what WebCrypto takes; DER would be 70-72.
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64)
    expect(await phoneAccepts(box.publicKey, 'evt_one', HOST, nonce, signature)).toBe(true)
  })

  it('answers for its own event, this address and this challenge only', async () => {
    const box = boxIdentity(settings())
    const nonce = challenge()
    const signature = box.sign('evt_one', HOST, nonce)
    expect(await phoneAccepts(box.publicKey, 'evt_two', HOST, nonce, signature)).toBe(false)
    expect(await phoneAccepts(box.publicKey, 'evt_one', HOST, challenge(), signature)).toBe(false)
    // A phone that connected somewhere else: a relay passing the answer on.
    expect(await phoneAccepts(box.publicKey, 'evt_one', '10.0.0.66:8787', nonce, signature)).toBe(
      false
    )
  })

  it('is its own for every database, so another box cannot answer for it', async () => {
    const ours = boxIdentity(settings())
    const theirs = boxIdentity(settings())
    expect(theirs.publicKey).not.toBe(ours.publicKey)
    const nonce = challenge()
    expect(
      await phoneAccepts(
        ours.publicKey,
        'evt_one',
        HOST,
        nonce,
        theirs.sign('evt_one', HOST, nonce)
      )
    ).toBe(false)
  })

  it('answers with s in the lower half, the form every verifier takes', async () => {
    const box = boxIdentity(settings())
    for (let i = 0; i < 64; i++) {
      const nonce = challenge()
      const signature = Buffer.from(box.sign('evt_one', HOST, nonce), 'base64url')
      const s = BigInt(`0x${signature.subarray(32).toString('hex')}`)
      // Half of all signatures come out of signing in the upper half, so 64
      // in a row in the lower one is no accident.
      expect(s <= N >> 1n, `signature ${i}`).toBe(true)
      expect(
        await phoneAccepts(box.publicKey, 'evt_one', HOST, nonce, signature.toString('base64url'))
      ).toBe(true)
      if (i === 0) {
        // The twin in the upper half verifies too, which is why WebCrypto
        // alone never needed this.
        const twin = Buffer.concat([
          signature.subarray(0, 32),
          Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex'),
        ])
        expect(
          await phoneAccepts(box.publicKey, 'evt_one', HOST, nonce, twin.toString('base64url'))
        ).toBe(true)
      }
    }
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
    expect(
      await phoneAccepts(box.publicKey, 'evt_one', HOST, nonce, box.sign('evt_one', HOST, nonce))
    ).toBe(true)
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

describe('the address it signs for', () => {
  const plain = (localAddress?: string) => ({ localAddress, tls: false })
  const overTls = (localAddress?: string) => ({ localAddress, tls: true })
  const refused = { status: 421 }

  it('is an IP address when that is where the connection arrived, port and all', () => {
    expect(hostToSign('10.0.0.5:8787', plain('10.0.0.5'), [])).toEqual({ host: '10.0.0.5:8787' })
    expect(hostToSign('10.0.0.5', plain('10.0.0.5'), [])).toEqual({ host: '10.0.0.5' })
    // A socket listening on both families reports an IPv4 arrival mapped.
    expect(hostToSign('10.0.0.5:8787', plain('::ffff:10.0.0.5'), [])).toEqual({
      host: '10.0.0.5:8787',
    })
    expect(hostToSign('[fe80::1]:8787', plain('fe80::1%en0'), [])).toEqual({
      host: '[fe80::1]:8787',
    })
    expect(hostToSign('[FE80:0:0::1]:8787', plain('fe80::1'), [])).toEqual({
      host: '[fe80:0:0::1]:8787',
    })
    // TLS or not: an address is checked by where the connection arrived.
    expect(hostToSign('10.0.0.5:8787', overTls('10.0.0.5'), ['crew.example.com'])).toEqual({
      host: '10.0.0.5:8787',
    })
  })

  it('is never an address the connection did not arrive at', () => {
    // A relay on the Wi-Fi asking for its own address.
    expect(hostToSign('10.0.0.66:8787', plain('10.0.0.5'), [])).toMatchObject(refused)
    // Or for loopback, so that a relay on the phone itself could pass it on.
    expect(hostToSign('127.0.0.1:8787', plain('10.0.0.5'), [])).toMatchObject(refused)
    expect(hostToSign('[::1]:8787', plain('10.0.0.5'), [])).toMatchObject(refused)
    // Behind a port forward, the phone's address is not the box's.
    expect(hostToSign('192.168.50.1:8787', plain('10.0.0.5'), [])).toMatchObject(refused)
    // Nowhere to compare with.
    expect(hostToSign('10.0.0.5:8787', plain(undefined), [])).toMatchObject(refused)
  })

  it('is localhost only when the connection came over loopback', () => {
    for (const at of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(hostToSign('localhost:4299', plain(at), [])).toEqual({ host: 'localhost:4299' })
    }
    for (const at of ['10.0.0.5', 'fe80::1', undefined]) {
      expect(hostToSign('localhost:4299', plain(at), [])).toMatchObject(refused)
    }
  })

  it('is a name only when it is on the certificate the connection was served with', () => {
    const names = ['Crew.Example.com']
    expect(hostToSign('crew.example.com:8787', overTls('10.0.0.5'), names)).toEqual({
      host: 'crew.example.com:8787',
    })
    // Signed in lower case, which is how a phone's own address reads.
    expect(hostToSign('CREW.example.COM', overTls('10.0.0.5'), names)).toEqual({
      host: 'crew.example.com',
    })
    // Over plain HTTP a relay could ask by any name, so no name counts.
    expect(hostToSign('crew.example.com:8787', plain('10.0.0.5'), names)).toMatchObject(refused)
    expect(hostToSign('crewbox.local:8787', plain('10.0.0.5'), [])).toMatchObject(refused)
    expect(hostToSign('evil.example.net:8787', overTls('10.0.0.5'), names)).toMatchObject(refused)
    expect(hostToSign('sub.crew.example.com', overTls('10.0.0.5'), names)).toMatchObject(refused)
  })

  it('is refused as malformed when the Host header is not an address or a name', () => {
    for (const header of [
      undefined,
      '',
      ':8787',
      '10.0.0.5:',
      '10.0.0.5:123456',
      'crew.example.com/x',
      'maya@crew.example.com',
      'crew example.com',
      'crew.example.com:8787\nevt_other',
      '[fe80::1%en0]:8787',
      '[zz::1]:8787',
      '[1::2::3]:8787',
    ]) {
      expect(hostToSign(header, plain('10.0.0.5'), []), String(header)).toMatchObject({
        status: 400,
      })
    }
  })
})

/** A GET over a real socket, with the Host header a phone, or a relay, would send. */
function ask(
  port: number,
  path: string,
  host: string,
  tls = false
): Promise<{ status: number; body: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const request = (tls ? httpsRequest : httpRequest)(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: { host },
        ...(tls ? { rejectUnauthorized: false, servername: 'crew.test' } : {}),
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (text += chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(text || '{}') as Record<string, string>,
          })
        )
      }
    )
    request.on('error', reject)
    request.end()
  })
}

const portOf = (app: App): number => (app.server.address() as AddressInfo).port

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

  it('publishes the key before sign-in, and answers a challenge at the address it was asked at', async () => {
    const { eventId, eventKey } = await config()
    expect(Buffer.from(eventKey, 'base64url')).toHaveLength(65)

    await app.listen({ host: '127.0.0.1', port: 0 })
    const host = `127.0.0.1:${portOf(app)}`
    const nonce = challenge()
    const res = await ask(portOf(app), `/api/identity?nonce=${nonce}`, host)
    expect(res.status).toBe(200)
    expect(res.body.eventId).toBe(eventId)
    expect(res.body.key).toBe(eventKey)
    // Checked against the key the phone kept from /api/config, not the one
    // in the answer, and the address the phone connected to, which is how a
    // phone must check it.
    expect(await phoneAccepts(eventKey, eventId, host, nonce, res.body.signature!)).toBe(true)
    expect(
      await phoneAccepts(eventKey, eventId, `10.0.0.66:${portOf(app)}`, nonce, res.body.signature!)
    ).toBe(false)
  })

  it('will not sign for an address the request did not arrive at', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = portOf(app)
    for (const host of [
      `10.0.0.66:${port}`,
      `192.168.1.10:${port}`,
      `[::1]:${port}`,
      `crew.test:${port}`,
      `crewbox.local:${port}`,
    ]) {
      const res = await ask(port, `/api/identity?nonce=${challenge()}`, host)
      expect(res.status, host).toBe(421)
      expect(res.body.signature, host).toBeUndefined()
    }
    const malformed = await ask(port, `/api/identity?nonce=${challenge()}`, `crew.test:${port}/x`)
    expect(malformed.status).toBe(400)
  })

  it('signs for localhost from this machine', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const host = `localhost:${portOf(app)}`
    const { eventId, eventKey } = await config()
    const nonce = challenge()
    const res = await ask(portOf(app), `/api/identity?nonce=${nonce}`, host)
    expect(res.status).toBe(200)
    expect(await phoneAccepts(eventKey, eventId, host, nonce, res.body.signature!)).toBe(true)
  })

  // A connection to one of this machine's own network addresses arrives
  // there, not on loopback, and one can be sent from either, so the box's
  // address and the asker's differ, as a relay's do.
  const lan = lanIps()[0]
  it.skipIf(!lan)('signs for where a request arrived, never where it came from', async () => {
    await app.listen({ host: '0.0.0.0', port: 0 })
    const port = portOf(app)
    const via = (to: string, from: string | undefined, host: string) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            host: to,
            port,
            path: `/api/identity?nonce=${challenge()}`,
            headers: { host },
            ...(from ? { localAddress: from } : {}),
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          }
        )
        request.on('error', reject)
        request.end()
      })
    expect(await via(lan!, undefined, `${lan}:${port}`)).toBe(200)
    expect(await via(lan!, undefined, `localhost:${port}`)).toBe(421)
    expect(await via(lan!, undefined, `127.0.0.1:${port}`)).toBe(421)
    // Arriving on loopback from the network address: the asker's address is
    // not the box's, whatever the Host header says.
    expect(await via('127.0.0.1', lan, `${lan}:${port}`)).toBe(421)
    expect(await via('127.0.0.1', lan, `127.0.0.1:${port}`)).toBe(200)
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

describe('over HTTPS', () => {
  let dir: string
  let app: App
  let closeMirror: (() => Promise<void>) | undefined

  beforeEach(() => {
    dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-identity-tls-'))
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        pathJoin(dir, KEY_FILE),
        '-out',
        pathJoin(dir, CERT_FILE),
        '-days',
        '1',
        '-subj',
        '/CN=crew.test',
      ],
      { stdio: 'ignore' }
    )
    const { tls } = loadTls(dir)
    const store = new Store(openDb(':memory:'))
    app = buildApp({ store, eventPin: '4242', tls: tls!, dataDir: dir, logger: false })
  })

  afterEach(async () => {
    await closeMirror?.()
    closeMirror = undefined
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('signs for the name on its certificate, over TLS', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = portOf(app)
    const { eventId, eventKey } = (await app.inject({ method: 'GET', url: '/api/config' })).json()
    const nonce = challenge()
    const res = await ask(port, `/api/identity?nonce=${nonce}`, `CREW.test:${port}`, true)
    expect(res.status).toBe(200)
    expect(
      await phoneAccepts(eventKey, eventId, `crew.test:${port}`, nonce, res.body.signature!)
    ).toBe(true)
    const other = await ask(port, `/api/identity?nonce=${challenge()}`, `other.test:${port}`, true)
    expect(other.status).toBe(421)
  })

  it('does not sign for that name over plain HTTP, even from this machine', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 })
    // The plain mirror a pinned box keeps on loopback (mirrorOnLoopback),
    // on a port of its own here since the box already has 127.0.0.1.
    const free = createServer()
    await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve))
    const mirrorPort = (free.address() as AddressInfo).port
    await new Promise<void>((resolve) => free.close(() => resolve()))
    closeMirror = await mirrorOnLoopback(app, mirrorPort)

    const byName = await ask(
      mirrorPort,
      `/api/identity?nonce=${challenge()}`,
      `crew.test:${mirrorPort}`
    )
    expect(byName.status).toBe(421)
    const byLocalhost = await ask(
      mirrorPort,
      `/api/identity?nonce=${challenge()}`,
      `localhost:${mirrorPort}`
    )
    expect(byLocalhost.status).toBe(200)
  })
})
