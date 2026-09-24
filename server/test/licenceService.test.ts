import { generateKeyPairSync, sign as signWith } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { machineHash, type LicenceFetch } from '../src/licence/sdk.ts'
import {
  KEY_SETTING,
  LicenceProblem,
  LicenceService,
  TOKEN_SETTING,
  type LicenceServiceOptions,
} from '../src/licence/service.ts'
import type { LicencePolicy } from '../src/licence/decide.ts'

/**
 * The wire half, with the HTTP boundary stubbed and nothing else.
 *
 * The stand-in service below behaves like the real one where it matters: it
 * HASHES whatever `machine` it is sent and signs that hash into the token, so
 * a client that pre-hashed would get tokens for sha256(sha256(id)) and fail
 * exactly as it would in the field. Its replies mirror the documented shapes,
 * errors included: `{ ok: false, reason, message }` with a 4xx/5xx.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  .subarray(-32)
  .toString('hex')

/** A raw machine id, upper case at source the way macOS reports it. */
const FINGERPRINT = '9E5B4C1A-0000-4000-8000-ABCDEF012345'
const HASH = machineHash(FINGERPRINT)
const KEY = 'LT-CREW-K7M2-9PQR-4XTC'
const DAY = 86_400
const NOW = 1_780_000_000

function mint(over: Record<string, unknown> = {}): string {
  const claims = {
    v: 1,
    key: KEY,
    product: 'crewbox',
    edition: 'standard',
    customer: '11111111-2222-3333-4444-555555555555',
    name: 'Test Buyer',
    seats: 1,
    maintUntil: NOW + 365 * DAY,
    exp: NOW + 90 * DAY,
    machine: HASH,
    mode: 'online',
    iat: NOW,
    jti: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ...over,
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const sig = signWith(null, Buffer.from(payload), privateKey).toString('base64url')
  return `${payload}.${sig}`
}

interface Call {
  path: string
  body: Record<string, unknown>
}

type Handler = (
  path: string,
  body: Record<string, unknown>
) => { status: number; json: Record<string, unknown> } | 'offline'

/** The real service's happy path: hash what arrives, sign it in, echo it. */
const honest: Handler = (path, body) => {
  const machine = machineHash(String(body.machine))
  switch (path) {
    case '/api/licence/activate':
      return {
        status: 200,
        json: {
          ok: true,
          token: mint({ machine, key: body.key }),
          machine,
          product: 'crewbox',
          edition: 'standard',
          seats: 1,
          seatsUsed: 1,
          checkInBy: '2026-12-01T00:00:00.000Z',
          maintenanceUntil: '2027-08-21T00:00:00.000Z',
        },
      }
    case '/api/licence/heartbeat':
      return {
        status: 200,
        json: {
          ok: true,
          token: mint({ machine, key: body.key, exp: NOW + 180 * DAY }),
          machine,
          checkInBy: '2027-03-01T00:00:00.000Z',
          maintenanceUntil: '2027-08-21T00:00:00.000Z',
        },
      }
    case '/api/licence/trial':
      return {
        status: 200,
        json: {
          ok: true,
          key: 'LT-CREW-TR1A-L000-0000',
          token: mint({
            machine,
            key: 'LT-CREW-TR1A-L000-0000',
            edition: 'trial',
            exp: NOW + 30 * DAY,
            maintUntil: NOW + 30 * DAY,
          }),
          machine,
          expiresAt: '2026-06-28T00:00:00.000Z',
          checkInBy: '2026-06-28T00:00:00.000Z',
        },
      }
    case '/api/licence/deactivate':
      return { status: 200, json: { ok: true } }
    default:
      return { status: 404, json: { ok: false, reason: 'bad_request', message: 'no such route' } }
  }
}

const refuse =
  (status: number, reason: string, message: string): Handler =>
  () => ({ status, json: { ok: false, reason, message } })

function stubFetch(handler: Handler, calls: Call[]): LicenceFetch {
  return async (url, init) => {
    const path = new URL(url).pathname
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ path, body })
    const answer = handler(path, body)
    if (answer === 'offline') throw new TypeError('fetch failed')
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.json,
    }
  }
}

const settings = () => {
  const rows = new Map<string, string>()
  return {
    rows,
    getSetting: (k: string) => rows.get(k),
    setSetting: (k: string, v: string) => void rows.set(k, v),
  }
}

function service(
  handler: Handler = honest,
  over: Partial<LicenceServiceOptions> & { policy?: LicencePolicy; at?: () => number } = {}
) {
  const calls: Call[] = []
  const store = settings()
  const licence = new LicenceService({
    settings: store,
    fingerprint: FINGERPRINT,
    buildDate: NOW - DAY,
    publicKeyHex: PUB,
    fetch: stubFetch(handler, calls),
    now: over.at ?? (() => NOW * 1000),
    label: 'test box',
    ...over,
  })
  return { licence, calls, store }
}

const problem = async (p: Promise<unknown> | (() => unknown)): Promise<LicenceProblem> => {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (err) {
    if (err instanceof LicenceProblem) return err
    throw err
  }
  throw new Error('expected a LicenceProblem')
}

describe('what goes on the wire', () => {
  it('sends the RAW fingerprint, and the product, on activate', async () => {
    const { licence, calls } = service()
    const status = await licence.activate('lt-crew-k7m2-9pqr-4xtc')
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/api/licence/activate')
    expect(calls[0].body.machine).toBe(FINGERPRINT)
    expect(calls[0].body.machine).not.toBe(HASH)
    expect(calls[0].body.product).toBe('crewbox')
    expect(calls[0].body.key).toBe(KEY)
    expect(status.status).toBe('active')
    expect(status.watermark).toBe(false)
  })

  it('sends the raw fingerprint and product on heartbeat, and keeps the fresh token', async () => {
    const { licence, calls, store } = service()
    await licence.activate(KEY)
    const before = store.rows.get(TOKEN_SETTING)
    const status = await licence.checkIn()
    const beat = calls.find((c) => c.path === '/api/licence/heartbeat')!
    expect(beat.body).toEqual({ key: KEY, machine: FINGERPRINT, product: 'crewbox' })
    expect(store.rows.get(TOKEN_SETTING)).not.toBe(before)
    // the new lease is what the panel shows
    expect(status.licence?.checkInBy).toBe((NOW + 180 * DAY) * 1000)
    expect(status.lastCheckIn).toMatchObject({ ok: true, error: null })
  })

  it('starts a trial with the product, raw fingerprint and email, and stores its key', async () => {
    const { licence, calls, store } = service()
    const status = await licence.startTrial(' vj@example.com ', 'VJ')
    expect(calls[0].body).toEqual({
      product: 'crewbox',
      email: 'vj@example.com',
      name: 'VJ',
      machine: FINGERPRINT,
    })
    expect(status.licence?.edition).toBe('trial')
    expect(store.rows.get(KEY_SETTING)).toBe('LT-CREW-TR1A-L000-0000')
  })
})

describe('the echoed machine is asserted before anything is stored', () => {
  it('refuses a reply that recorded a different machine', async () => {
    const { licence, store } = service((path, body) => {
      const real = honest(path, body)
      if (real === 'offline') return real
      return { ...real, json: { ...real.json, machine: machineHash(HASH) } }
    })
    const p = await problem(licence.activate(KEY))
    expect(p.status).toBe(502)
    expect(p.message).toMatch(/mismatch/i)
    expect(store.rows.get(TOKEN_SETTING)).toBeUndefined()
    expect(licence.verdict().status).toBe('invalid')
  })

  it('refuses a reply that does not say which machine it bound', async () => {
    const { licence, store } = service((path, body) => {
      const real = honest(path, body)
      if (real === 'offline') return real
      const { machine: _machine, ...rest } = real.json
      return { ...real, json: rest }
    })
    await problem(licence.activate(KEY))
    expect(store.rows.get(TOKEN_SETTING)).toBeUndefined()
  })

  it('a client that pre-hashed would be caught — the arithmetic of the Light bug', () => {
    // What the service does with what it is sent.
    expect(machineHash(FINGERPRINT)).toBe(HASH)
    expect(machineHash(HASH), 'sending the hash mints a token for no machine').not.toBe(HASH)
  })

  it('gives the seat back when it will not keep the token', async () => {
    const { licence, calls } = service((path, body) =>
      path === '/api/licence/activate'
        ? {
            status: 200,
            // a vizz token, correctly bound to this box
            json: { ok: true, token: mint({ product: 'vizz' }), machine: HASH },
          }
        : honest(path, body)
    )
    const p = await problem(licence.activate(KEY))
    expect(p.message).toMatch(/for Vizz, not Crewbox/)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.map((c) => c.path)).toContain('/api/licence/deactivate')
  })
})

describe("the service's refusals reach the admin in its own words", () => {
  it('shows `message`, carries `reason`, and never answers 403', async () => {
    for (const [status, reason, message] of [
      [403, 'revoked', 'This licence was revoked after a refund.'],
      [403, 'expired', 'Your trial has ended.'],
      [409, 'no_seats', 'All 1 seats are in use. Release one at letissier.ie/account.'],
      [404, 'unknown_key', 'No licence with that key.'],
      [400, 'malformed_key', 'That key has a typo in it.'],
      [409, 'wrong_product', 'That key is for Vizz.'],
      [500, 'server_error', 'Something went wrong. Try again.'],
    ] as const) {
      const { licence, store } = service(refuse(status, reason, message))
      const p = await problem(licence.activate(KEY))
      expect(p.message).toBe(message)
      expect(p.reason).toBe(reason)
      // 403 would read as "your admin unlock died" in the panel
      expect(p.status).toBe(422)
      expect(store.rows.get(TOKEN_SETTING)).toBeUndefined()
    }
  })

  it('shows the trial refusal the same way', async () => {
    const { licence } = service(
      refuse(409, 'trial_already_used', 'This machine has already had a trial.')
    )
    const p = await problem(licence.startTrial('vj@example.com'))
    expect(p.message).toBe('This machine has already had a trial.')
  })

  it("refuses another product's key before it can take a seat", async () => {
    const { licence, calls } = service()
    const p = await problem(licence.activate('LT-V1ZZ-K7M2-9PQR-4XTC'))
    expect(p.message).toMatch(/Vizz/)
    expect(calls).toHaveLength(0)
  })
})

describe('offline is the normal state of a festival box', () => {
  it('keeps the cached licence when the service cannot be reached', async () => {
    let online = true
    const { licence, store } = service((path, body) => (online ? honest(path, body) : 'offline'))
    await licence.activate(KEY)
    const token = store.rows.get(TOKEN_SETTING)
    online = false
    const p = await problem(licence.checkIn())
    expect(p.status).toBe(503)
    expect(p.message).toMatch(/offline/i)
    expect(store.rows.get(TOKEN_SETTING)).toBe(token)
    expect(licence.verdict().status).toBe('active')
    expect(licence.status().lastCheckIn).toMatchObject({ ok: false })
  })

  it('keeps the cached licence when the service refuses a check-in for any other reason', async () => {
    for (const [status, reason] of [
      [404, 'not_activated'],
      [404, 'unknown_key'],
      [403, 'expired'],
      [409, 'wrong_product'],
      [500, 'server_error'],
    ] as const) {
      let refusing = false
      const { licence, store } = service((path, body) =>
        refusing ? refuse(status, reason, 'No.')(path, body) : honest(path, body)
      )
      await licence.activate(KEY)
      const token = store.rows.get(TOKEN_SETTING)
      refusing = true
      await problem(licence.checkIn())
      expect(store.rows.get(TOKEN_SETTING), reason).toBe(token)
      expect(licence.verdict().status, reason).toBe('active')
    }
  })
})

describe('a refund ends the licence', () => {
  /** A box licensed and then refunded: the service now answers `revoked`. */
  async function refunded(clock: { now: number } = { now: NOW * 1000 }) {
    let revoked = false
    const s = service(
      (path, body) =>
        revoked
          ? refuse(403, 'revoked', 'This licence was revoked after a refund.')(path, body)
          : honest(path, body),
      { policy: 'lock', at: () => clock.now }
    )
    await s.licence.activate(KEY)
    expect(s.licence.effects().locked).toBe(false)
    revoked = true
    return s
  }

  it('drops the token, keeps the key, and restricts — from the admin button', async () => {
    const { licence, store } = await refunded()
    const seen: boolean[] = []
    licence.onChange((effects) => seen.push(effects.locked))
    const p = await problem(licence.checkIn())
    expect(p.status).toBe(422)
    expect(p.reason).toBe('revoked')
    expect(p.message).toBe('This licence was revoked after a refund.')
    expect(store.rows.get(TOKEN_SETTING) || undefined).toBeUndefined()
    expect(store.rows.get(KEY_SETTING)).toBe(KEY)
    expect(licence.verdict().status).toBe('invalid')
    expect(licence.effects()).toEqual({ restricted: true, watermark: true, locked: true })
    // the hub is told at once, so phones get the drawer line
    expect(seen).toEqual([true])
  })

  it('does the same from the background check-in, without throwing', async () => {
    const clock = { now: NOW * 1000 }
    const { licence, store } = await refunded(clock)
    // a day on, so the background loop is due to try again
    clock.now = (NOW + 2 * DAY) * 1000
    await expect(licence.backgroundCheckIn()).resolves.toBeUndefined()
    expect(store.rows.get(TOKEN_SETTING) || undefined).toBeUndefined()
    expect(store.rows.get(KEY_SETTING)).toBe(KEY)
    expect(licence.effects().locked).toBe(true)
  })

  it('comes back by itself with the kept key if the licence is reinstated', async () => {
    let revoked = true
    const { licence, store } = service((path, body) =>
      revoked ? refuse(403, 'revoked', 'Revoked.')(path, body) : honest(path, body)
    )
    store.setSetting(KEY_SETTING, KEY)
    store.setSetting(TOKEN_SETTING, mint())
    await problem(licence.checkIn())
    expect(licence.verdict().status).toBe('invalid')
    revoked = false
    await licence.checkIn()
    expect(licence.verdict().status).toBe('active')
  })
})

describe('offline is the normal state of a festival box, continued', () => {
  it('never throws from the background check-in', async () => {
    const { licence, store } = service(() => 'offline')
    store.setSetting(KEY_SETTING, KEY)
    store.setSetting(TOKEN_SETTING, mint())
    await expect(licence.backgroundCheckIn()).resolves.toBeUndefined()
    expect(licence.verdict().status).toBe('active')
  })

  it('does not reach for the network at all without a key', async () => {
    const { licence, calls } = service()
    await licence.backgroundCheckIn()
    expect(calls).toHaveLength(0)
  })

  it('checks in at most daily once one has worked', async () => {
    let now = NOW * 1000
    const { licence, calls } = service(honest, { at: () => now })
    await licence.activate(KEY)
    await licence.backgroundCheckIn()
    expect(calls.filter((c) => c.path === '/api/licence/heartbeat')).toHaveLength(0)
    now += 25 * 60 * 60_000
    await licence.backgroundCheckIn()
    expect(calls.filter((c) => c.path === '/api/licence/heartbeat')).toHaveLength(1)
  })

  it('accepts a pasted offline token with no network at all', () => {
    const { licence, calls, store } = service(() => 'offline')
    const status = licence.acceptToken(`  ${mint({ mode: 'offline' })}\n`)
    expect(status.status).toBe('active')
    expect(status.licence?.mode).toBe('offline')
    // the key comes out of the token, so a later check-in has something to use
    expect(store.rows.get(KEY_SETTING)).toBe(KEY)
    expect(calls).toHaveLength(0)
  })

  it('refuses a pasted token for another box, or another product, and says whose', () => {
    const { licence, store } = service()
    const other = problem(() => licence.acceptToken(mint({ machine: machineHash('ANOTHER-BOX') })))
    const vizz = problem(() => licence.acceptToken(mint({ product: 'vizz' })))
    const junk = problem(() => licence.acceptToken('not-a-token'))
    return Promise.all([other, vizz, junk]).then(([a, b, c]) => {
      expect(a.message).toMatch(/another machine/)
      expect(b.message).toMatch(/for Vizz, not Crewbox/)
      expect(c.message).toMatch(/can verify/)
      expect(store.rows.get(TOKEN_SETTING)).toBeUndefined()
    })
  })

  it('shows the request code raw, and the machine as the service names it', () => {
    const { licence } = service()
    const status = licence.status()
    expect(status.requestCode).toBe(FINGERPRINT)
    expect(status.machine).toBe(HASH)
  })

  it('releases best effort, and forgets locally even when offline', async () => {
    let online = true
    const { licence, store } = service((path, body) => (online ? honest(path, body) : 'offline'))
    await licence.activate(KEY)
    online = false
    const { status, released } = await licence.release()
    expect(released).toBe(false)
    expect(status.status).toBe('invalid')
    expect(status.key).toBeNull()
    expect(store.rows.get(TOKEN_SETTING)).toBe('')
  })
})

describe('what an unlicensed box looks like', () => {
  it('is marked and locked by default — "trial, then lock"', () => {
    const { licence } = service()
    expect(licence.effects()).toEqual({ restricted: true, watermark: true, locked: true })
  })

  it('is left alone under open, and marked but not locked under watermark', () => {
    expect(service(honest, { policy: 'open' }).licence.effects().watermark).toBe(false)
    expect(service(honest, { policy: 'watermark' }).licence.effects()).toEqual({
      restricted: true,
      watermark: true,
      locked: false,
    })
  })

  it('unlocks for a trial, and locks again when the trial ends', async () => {
    let now = NOW * 1000
    let online = true
    const { licence } = service((path, body) => (online ? honest(path, body) : 'offline'), {
      at: () => now,
    })
    expect(licence.effects().locked).toBe(true)
    await licence.startTrial('vj@example.com')
    online = false
    expect(licence.effects().locked).toBe(false)
    now = (NOW + 31 * DAY) * 1000
    expect(licence.effects().locked).toBe(true)
  })

  it('restricts nothing on a box that cannot read its own id (and says why)', async () => {
    const { licence } = service(honest, { fingerprint: null })
    expect(licence.status().requestCode).toBeNull()
    const p = await problem(licence.activate(KEY))
    expect(p.message).toMatch(/machine id/)
  })

  it('marks a trial that ends while the box is running, and tells the listeners', async () => {
    let now = NOW * 1000
    let online = true
    const { licence } = service((path, body) => (online ? honest(path, body) : 'offline'), {
      at: () => now,
    })
    await licence.startTrial('vj@example.com')
    online = false
    const seen: boolean[] = []
    licence.onChange((effects) => seen.push(effects.watermark))
    expect(licence.effects().watermark).toBe(false)

    now = (NOW + 31 * DAY) * 1000
    expect(licence.verdict().status).toBe('expired')
    // what the hourly timer does: try (offline, so nothing), then re-read
    await licence.backgroundCheckIn()
    expect(seen).toEqual([true])
  })

  it('never restricts a lapsed paid lease — it asks for a check-in', () => {
    const { licence, store } = service()
    store.setSetting(TOKEN_SETTING, mint({ exp: NOW - 1 }))
    expect(licence.verdict().status).toBe('check_in_required')
    expect(licence.effects().restricted).toBe(false)
  })

  it('restricts nothing on a build with no usable verifying key', () => {
    const { licence } = service(honest, { publicKeyHex: 'REPLACE_WITH_YOUR_PUBLIC_KEY_HEX' })
    expect(licence.effects()).toEqual({ restricted: false, watermark: false, locked: false })
  })
})
