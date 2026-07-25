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
