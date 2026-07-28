import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function hashPin(pin: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(pin, salt, 32)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPin(pin: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const hash = scryptSync(pin, Buffer.from(saltHex, 'hex'), 32)
  const expected = Buffer.from(hashHex, 'hex')
  return hash.length === expected.length && timingSafeEqual(hash, expected)
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

// 32 characters exactly, so a byte mod 32 is unbiased. No 'i' or 'l' — with
// no 0 or 1 in the set the usual o/0 and i/1 confusions can't arise, but i
// and l look alike in most terminal fonts and this gets read off a screen and
// typed into a phone, often in the dark.
const PASSWORD_ALPHABET = 'abcdefghjkmnopqrstuvwxyz23456789'

/**
 * A random admin password, in the shape Apple uses for app passwords:
 * `k7fm-q2xr-9dvn`. The hyphens are part of the string, not decoration — it
 * is compared exactly, because normalising input would quietly break any
 * password an admin chose that legitimately contains a hyphen.
 *
 * 60 bits. Overkill against the rate limiter on the unlock route, which is
 * the point: this is the one credential that is not on a poster.
 */
export function newAdminPassword(): string {
  const bytes = randomBytes(12)
  const chars = Array.from(bytes, (b) => PASSWORD_ALPHABET[b % 32])
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)]
    .map((group) => group.join(''))
    .join('-')
}

/**
 * Short-lived tokens proving someone typed the admin password.
 *
 * Deliberately not a column on the session: an admin unlock has to end when
 * the app closes, while a session is what keeps crew signed in for weeks. The
 * client holds this in memory and never writes it to storage, so closing the
 * app forgets it; the TTL here bounds the damage if it leaks anyway, and the
 * whole map dying with the process means a box restart re-locks every panel.
 */
export class AdminTokens {
  private issued = new Map<string, number>()

  constructor(private readonly ttlMs: number) {}

  issue(): string {
    const token = newToken()
    this.issued.set(token, Date.now() + this.ttlMs)
    return token
  }

  valid(token: string | undefined): boolean {
    if (!token) return false
    const expires = this.issued.get(token)
    if (expires === undefined) return false
    if (expires <= Date.now()) {
      this.issued.delete(token)
      return false
    }
    return true
  }

  revoke(token: string | undefined): void {
    if (token) this.issued.delete(token)
  }

  /** Drop every token — used when the password changes. */
  revokeAll(): void {
    this.issued.clear()
  }

  sweep(): void {
    const now = Date.now()
    for (const [token, expires] of this.issued) if (expires <= now) this.issued.delete(token)
  }
}

/** Sliding-window limiter for PIN attempts, keyed by IP. */
export class RateLimiter {
  private hits = new Map<string, number[]>()

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  allow(key: string): boolean {
    const now = Date.now()
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.max) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }

  /** True if the key is over its limit — checks without recording an attempt. */
  blocked(key: string): boolean {
    const now = Date.now()
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length === 0) this.hits.delete(key)
    else this.hits.set(key, recent)
    return recent.length >= this.max
  }

  /** Record one event against the key (e.g. a failed login) without gating. */
  record(key: string): void {
    const now = Date.now()
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    recent.push(now)
    this.hits.set(key, recent)
  }

  /** Forget a key — e.g. a successful login clears its failure count. */
  clear(key: string): void {
    this.hits.delete(key)
  }

  /**
   * Drop keys whose window has fully elapsed. Without this the map grows for
   * the process lifetime — one entry per distinct IP, unbounded under an
   * IP-rotating brute force. Call periodically.
   */
  sweep(): void {
    const cutoff = Date.now() - this.windowMs
    for (const [key, times] of this.hits) {
      if (times.every((t) => t < cutoff)) this.hits.delete(key)
    }
  }
}
