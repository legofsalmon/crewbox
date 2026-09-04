import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TRACKED_KEYS, RateLimiter } from '../src/auth.ts'
import { EXPOSED_PIN_MIN_LENGTH } from '../src/config.ts'
import { buildApp, type App } from '../src/app.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'

/**
 * Whose word the box takes for who a request is from.
 *
 * `req.ip` is the key every per-IP limiter holds — the join throttle, the
 * admin unlock, the control key. Behind a tunnel it has to come from
 * `X-Forwarded-For`, because the socket peer is always localhost. On the
 * festival Wi-Fi it must not, because there the header is a phone's opinion
 * about itself.
 *
 * `trustProxy: 1` did not draw that line. A number does not mean "trust one
 * hop" — Fastify compiles it to "take index 0 of the address chain", whoever
 * the peer is — so a crew phone talking straight to the box had its own
 * header believed, and a fresh value per request walked past every limiter.
 * Naming the loopback addresses says what was meant all along.
 */

const EVENT_PIN = '9999'
let app: App
let db: DatabaseSync | undefined
let dir: string

const build = (trustProxy: boolean) => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-fwd-'))
  db = openDb(':memory:')
  const store = new Store(db)
  store.createChannel('general', 'public', 'Everyone')
  return buildApp({
    store,
    eventPin: EVENT_PIN,
    adminPassword: 'forwarded-admin-pass',
    filesDir: dir,
    dataDir: dir,
    trustProxy,
    logger: false,
  })
}

afterEach(() => {
  // The limiter tests below build no app, so there may be nothing to close.
  try {
    db?.close()
  } catch {
    // Already closed by a previous block.
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** A request, from a chosen peer, carrying a chosen forwarded header. */
const from = (peer: string | undefined, forwarded: string | undefined, name = 'Someone') =>
  app.inject({
    method: 'POST',
    url: '/api/join',
    ...(peer ? { remoteAddress: peer } : {}),
    ...(forwarded ? { headers: { 'x-forwarded-for': forwarded } } : {}),
    payload: { name, eventPin: 'wrong-pin', personalPin: '4321' },
  })

describe('a box behind a tunnel', () => {
  beforeEach(() => {
    app = build(true)
  })

  it('believes the header when the request came in on loopback', async () => {
    // Which is where cloudflared and Caddy hand it over, and the only place
    // the header is anybody but the client talking about themselves.
    const rotating = Array.from({ length: 12 }, (_, i) => `203.0.113.${i}`)
    const codes: number[] = []
    for (const ip of rotating) codes.push((await from('127.0.0.1', ip)).statusCode)
    // Twelve distinct real clients, each with its own allowance: the join
    // limiter is 10 per IP per minute, so none of them is throttled.
    expect(codes.every((c) => c === 401)).toBe(true)
  })

  it('ignores the header from a phone on the festival Wi-Fi', async () => {
    // The whole finding. One LAN client, a fresh forged address per request:
    // with the header believed, every one got its own bucket and the limiter
    // never fired.
    const codes: number[] = []
    for (let i = 0; i < 14; i++) {
      codes.push((await from('192.168.1.50', `203.0.113.${i}`)).statusCode)
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0)
  })

  it('does not let a junk header become the key either', async () => {
    // `req.ip` under a trusted proxy is the raw header token — unvalidated,
    // and up to Node's 16 KB header limit. Used as a map key that is a way to
    // fill a box's memory as well as a way past the limiter.
    const codes: number[] = []
    for (let i = 0; i < 14; i++) {
      codes.push((await from('192.168.1.50', `not-an-ip-${i}`)).statusCode)
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0)
  })

  it('is not fooled by a very large header', async () => {
    const huge = `${'x'.repeat(15_000)}`
    const codes: number[] = []
    for (let i = 0; i < 14; i++) codes.push((await from('192.168.1.50', `${huge}${i}`)).statusCode)
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0)
  })
})

describe('a box on the LAN alone', () => {
  beforeEach(() => {
    app = build(false)
  })

  it('ignores forwarded headers entirely', async () => {
    const codes: number[] = []
    for (let i = 0; i < 14; i++) {
      codes.push((await from('192.168.1.50', `203.0.113.${i}`)).statusCode)
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0)
  })
})

describe('a burst of wrong PINs for one name', () => {
  beforeEach(() => {
    app = build(true)
  })

  it('does not let the scrypt window through unclaimed', async () => {
    /**
     * `verifyPinAsync` is scrypt: about a hundred milliseconds, on purpose.
     * The attempt used to be recorded only *after* it, so every guess that
     * arrived inside that window was verified before any of them had been
     * counted — forty at once got forty 401s and not one 429. On the LAN the
     * per-IP limiter contains that; through the tunnel, where the attacker
     * picks the address, it does not.
     */
    await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Alex', eventPin: EVENT_PIN, personalPin: '1111' },
    })

    // Forty at once, each from its own "real" client, so only the
    // per-account limiter can stop them.
    const guesses = Array.from({ length: 40 }, (_, i) =>
      app.inject({
        method: 'POST',
        url: '/api/join',
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
        payload: { name: 'Alex', eventPin: '', personalPin: '0000' },
      })
    )
    const codes = (await Promise.all(guesses)).map((r) => r.statusCode)
    // The limit is 10 per account. Thirty of the forty must be refused.
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(30)
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(10)
  })

  it('forgives a crew member who gets it right in the end', async () => {
    // Counting on arrival must not turn two fumbles into a lockout that
    // outlives the correct PIN.
    await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Sam', eventPin: EVENT_PIN, personalPin: '2222' },
    })
    for (let i = 0; i < 3; i++) {
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/join',
        payload: { name: 'Sam', eventPin: '', personalPin: '0000' },
      })
      expect(wrong.statusCode).toBe(401)
    }
    const right = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Sam', eventPin: '', personalPin: '2222' },
    })
    expect(right.statusCode).toBe(200)
  })
})

describe('how many keys a limiter will hold', () => {
  /**
   * The floor under the address check. A sweep runs every few minutes, so
   * between sweeps the map grows with every new key — measured at roughly a
   * gigabyte a minute from one LAN client with a 15 KB header. Address-based
   * trust closes that route; a bound holds whatever the key turns out to be.
   */
  it('stops growing at the cap', () => {
    const limiter = new RateLimiter(10, 60_000, 8)
    for (let i = 0; i < 500; i++) limiter.allow(`key-${i}`)
    expect(limiter.size()).toBeLessThanOrEqual(8)
  })

  it('keeps the newest keys, not the oldest', () => {
    // Under a flood the oldest entry is the least likely to be a crew member
    // still typing.
    const limiter = new RateLimiter(10, 60_000, 3)
    for (const key of ['a', 'b', 'c', 'd']) limiter.allow(key)
    expect(limiter.size()).toBe(3)
    // 'a' was evicted, so it starts fresh; 'd' is still counted.
    expect(limiter.blocked('a')).toBe(false)
  })

  it('leaves an ordinary crew well inside it', () => {
    const limiter = new RateLimiter(10, 60_000)
    for (let i = 0; i < 400; i++) limiter.allow(`10.0.0.${i % 256}-${Math.floor(i / 256)}`)
    expect(limiter.size()).toBe(400)
    expect(MAX_TRACKED_KEYS).toBeGreaterThan(1000)
  })
})

describe('first-run setup, once somebody has joined', () => {
  /**
   * `setupOpen()` was `countUsers() === 0` and nothing latched it. But
   * `DELETE /api/me` really deletes the row, and the App Store requirement
   * means the app offers exactly that — so when the last account removed
   * itself, the door swung back open on a box full of the event's messages.
   * Anyone who could reach it could then post a new event PIN and a new admin
   * password and read everything.
   */
  beforeEach(() => {
    app = build(false)
  })

  const joinAs = (name: string) =>
    app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name, eventPin: EVENT_PIN, personalPin: '4321' },
    })

  it('is open on a box nobody has joined', async () => {
    const res = await app.inject({ method: 'GET', url: '/setup' })
    expect(res.statusCode).toBe(200)
  })

  it('names the field that actually failed, not the PIN', async () => {
    // Every failure but the admin password used to read "Event PIN needs at
    // least 4 characters", so a mistyped adapter address sent whoever was
    // setting the box up to stare at the one field that was correct — on
    // the first page a new admin ever sees.
    const res = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: {
        eventName: 'Fine',
        eventPin: '4242',
        crewIface: 'not-an-address',
        adminPassword: '',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('crew adapter')
    expect(res.body).not.toContain('Event PIN needs at least 4 characters')
  })

  it('still says so when the PIN is the thing that is wrong', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: { eventName: 'Fine', eventPin: '12', adminPassword: '' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('Event PIN needs at least 4 characters')
  })

  it('closes once the first person joins', async () => {
    expect((await joinAs('Alex')).statusCode).toBe(200)
    const res = await app.inject({ method: 'GET', url: '/setup' })
    expect(res.statusCode).toBe(302)
  })

  it('stays closed after the last account deletes itself', async () => {
    // Load-out: the whole crew removes their accounts and walks away, and the
    // box sits in a van with the event on it.
    const joined = await joinAs('Alex')
    const { token } = joined.json() as { token: string }
    const gone = await app.inject({
      method: 'DELETE',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(gone.statusCode).toBe(200)

    const res = await app.inject({ method: 'GET', url: '/setup' })
    expect(res.statusCode).toBe(302)
  })

  it('refuses to take a new PIN and admin password through the closed door', async () => {
    const joined = await joinAs('Alex')
    const { token } = joined.json() as { token: string }
    await app.inject({
      method: 'DELETE',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    })

    const takeover = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: { eventName: 'Mine Now', eventPin: '0000', adminPassword: 'takeover-pass' },
    })
    expect(takeover.statusCode).toBe(302)
    // And nothing was changed by it.
    const joinWithOld = await joinAs('Sam')
    expect(joinWithOld.statusCode).toBe(200)
  })
})

describe('the join poster, off the LAN', () => {
  /**
   * `/connect` is a poster for a wall: a QR with the PIN prefilled and the
   * PIN in print, because somebody has to be able to type it. Right for a
   * phone on the festival Wi-Fi; not right for the internet, where the
   * runbook tells operators to treat the PIN as a real secret while this
   * page handed it to anybody who asked.
   */
  beforeEach(() => {
    app = build(true)
  })

  it('prints the PIN for a phone on the event network', async () => {
    const res = await app.inject({ method: 'GET', url: '/connect', remoteAddress: '192.168.1.50' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Event PIN')
    expect(res.body).toContain(EVENT_PIN)
  })

  it('withholds it from anyone else', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/connect',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(EVENT_PIN)
    expect(res.body).toContain('Ask the production office')
  })

  it('does not prefill it into the join link either', async () => {
    // The QR and the printed URL both carried `?pin=`, which is the same
    // secret in a different place.
    const res = await app.inject({
      method: 'GET',
      url: '/connect',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    })
    expect(res.body).not.toContain('pin=')
  })

  it('still shows the poster — just not the secret', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/connect',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    })
    expect(res.body).toContain('<svg')
  })
})

describe('a box that is on the internet', () => {
  /**
   * The fail-closed guard refused to start on the *default* event PIN when
   * the box was tunnel-exposed — and stopped there. A four-digit PIN set in
   * the admin panel, or minted by the box on first boot, sailed through it,
   * so the documented internet-exposed rig ran on a four-digit secret with
   * only the rate limiter between it and ten thousand guesses.
   *
   * On a LAN four digits is right: the PIN is on a poster on a wall and the
   * threat is somebody in the field. Through a tunnel it is not.
   */
  /**
   * `config` reads the environment once, at module load, so the module is
   * reset and re-imported per case rather than mutated in place.
   */
  const guard = async (trustProxy: boolean, storedPin: string): Promise<string | null> => {
    const before = process.env.CREWBOX_TRUST_PROXY
    process.env.CREWBOX_TRUST_PROXY = trustProxy ? '1' : '0'
    vi.resetModules()
    try {
      const { warnOnDefaults } = await import('../src/config.ts')
      return warnOnDefaults({ warn: () => {} }, Boolean(storedPin), storedPin)
    } finally {
      if (before === undefined) delete process.env.CREWBOX_TRUST_PROXY
      else process.env.CREWBOX_TRUST_PROXY = before
      vi.resetModules()
    }
  }

  it('refuses to start on a four-digit PIN', async () => {
    const fatal = await guard(true, '4821')
    expect(fatal).toContain('Refusing to start')
    expect(fatal).toContain(String(EXPOSED_PIN_MIN_LENGTH))
  })

  it('starts on one long enough to be out there', async () => {
    expect(await guard(true, 'a-real-secret-phrase')).toBeNull()
  })

  it('leaves a LAN box alone', async () => {
    // Four digits on a poster on a wall is the right answer there, and always
    // was.
    expect(await guard(false, '4821')).toBeNull()
  })
})
