/**
 * LeTissier licence verification — TypeScript / Node.
 *
 * The vendor's SDK (`clients/node/licence.ts` in the letissier.ie repo), copied
 * in as the integration guide says to. The verification half — `machineHash`,
 * `verify`, `check` — is the vendor's code unchanged apart from formatting, and
 * `server/test/licence.test.ts` holds it to the vendor's own vectors. Keep it
 * that way: every SDK in every language is proven against the same file, and
 * a local "improvement" here is exactly how two of them start disagreeing.
 *
 * Three things differ from the vendor copy, all in the client at the bottom:
 *
 * - `product` is sent on activate and heartbeat. The service is gaining a
 *   check that refuses another product's key before it takes a seat; today it
 *   ignores the field, so sending it is harmless.
 * - `fetch` is injectable, so the tests stub the HTTP boundary rather than the
 *   service, and a timeout bounds every call — a box on a venue uplink that
 *   swallows packets must not leave an admin's button spinning for ever.
 * - A refusal throws `LicenceRefusal` carrying the service's `reason` as well
 *   as its `message`. The message is what the admin sees; the reason is what
 *   the box can act on.
 *
 * What this file deliberately does NOT do is check `claims.product`. The
 * vendor SDKs leave that to the app — see `decide()` in ./decide.ts, which is
 * the only thing in crewbox that calls `check()`.
 */
import crypto from 'node:crypto'

/**
 * The studio's live licence signing key, from https://letissier.ie/integrate
 * ("Signing public key (embed this)").
 *
 * A *public* key: it can only verify, never mint, so it is safe in a binary and
 * safe in this repository. Compiled in rather than read from the environment —
 * a build that shipped with no key would verify nothing, silently, and look
 * exactly like a working one.
 */
export const PUBLIC_KEY_HEX = '1fca6c21f2eb7963fd646272a731a41a191d3a4cda839e295c5cda67978fcc85'

export interface Claims {
  v: number
  key: string
  product: string
  edition: 'standard' | 'trial' | string
  customer: string
  name?: string
  seats: number
  /** Entitled to builds released at or before this unix time. */
  maintUntil: number
  /** Check-in deadline for this lease. */
  exp: number
  machine: string
  mode: 'online' | 'offline' | string
  iat: number
  jti: string
}

export type Status =
  /** Good to run. */
  | 'active'
  /** Licence is fine, but this build is newer than the update entitlement. */
  | 'update_required'
  /** Lease lapsed. Check in to renew; app policy decides any grace. */
  | 'check_in_required'
  /** A trial that has run out. */
  | 'expired'
  /** Token was issued for a different machine. */
  | 'wrong_machine'
  /** Signature failed, malformed, or wrong version. */
  | 'invalid'

export interface Verdict {
  status: Status
  claims?: Claims
  /** Seconds until check-in is due; negative once overdue. */
  checkInIn?: number
}

/** SPKI wrapper so a raw 32-byte key can be used with node:crypto. */
function publicKeyFromHex(hex: string): crypto.KeyObject {
  const der = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(hex, 'hex'),
  ])

  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' })
}

/**
 * Must match the server exactly: sha256 of the trimmed fingerprint, first 32
 * hex characters.
 */
export function machineHash(fingerprint: string): string {
  return crypto.createHash('sha256').update(fingerprint.trim()).digest('hex').slice(0, 32)
}

/** Verify the signature and parse the claims. No clock or machine checks. */
export function verify(token: string, publicKeyHex: string = PUBLIC_KEY_HEX): Claims | null {
  const parts = token.split('.')

  if (parts.length !== 2) {
    return null
  }

  try {
    const ok = crypto.verify(
      null,
      Buffer.from(parts[0]),
      publicKeyFromHex(publicKeyHex),
      Buffer.from(parts[1], 'base64url')
    )

    if (!ok) {
      return null
    }

    const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Claims

    return claims.v === 1 ? claims : null
  } catch {
    return null
  }
}

/**
 * The whole decision, offline.
 *
 * @param buildDate  When THIS build was released (unix seconds). Bake it in at
 *                   compile time. This is what makes "a year of updates, yours
 *                   to keep" work with no server: an older build stays entitled
 *                   forever, a newer one asks for a renewal.
 */
export function check(options: {
  token: string
  fingerprint: string
  buildDate: number
  now?: number
  publicKeyHex?: string
}): Verdict {
  const claims = verify(options.token, options.publicKeyHex ?? PUBLIC_KEY_HEX)

  if (!claims) {
    return { status: 'invalid' }
  }

  if (claims.machine !== machineHash(options.fingerprint)) {
    return { status: 'wrong_machine', claims }
  }

  const now = options.now ?? Math.floor(Date.now() / 1000)
  const checkInIn = claims.exp - now

  if (checkInIn <= 0) {
    // A trial's lease is its lifetime, so a lapsed trial is simply over.
    return {
      status: claims.edition === 'trial' ? 'expired' : 'check_in_required',
      claims,
      checkInIn,
    }
  }

  if (options.buildDate > claims.maintUntil) {
    return { status: 'update_required', claims, checkInIn }
  }

  return { status: 'active', claims, checkInIn }
}

// ---------------------------------------------------------------------------
// Activation client
// ---------------------------------------------------------------------------

/** The service said no, in its own words. `message` is written for a person. */
export class LicenceRefusal extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'LicenceRefusal'
  }
}

/** The one piece of `fetch` the client uses, so tests can stand in for it. */
export type LicenceFetch = (
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export interface ClientOptions {
  baseUrl?: string
  fingerprint: string
  /** This app's product id, sent on activate and heartbeat. */
  product: string
  fetch?: LicenceFetch
  /** Give up on a call after this long. */
  timeoutMs?: number
}

/** What activate, heartbeat and trial all answer with. */
export interface TokenReply {
  token: string
  machine: string
  key?: string
  checkInBy?: string
  expiresAt?: string
  maintenanceUntil?: string
  edition?: string
  seats?: number
  seatsUsed?: number
}

export class LicenceClient {
  private readonly baseUrl: string
  private readonly fingerprint: string
  private readonly product: string
  private readonly fetch: LicenceFetch
  private readonly timeoutMs: number

  // Plain assignments rather than parameter properties: this file is meant to
  // be copied into other codebases, and parameter properties need a full
  // TypeScript compile rather than plain type stripping.
  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl ?? 'https://letissier.ie'
    this.fingerprint = options.fingerprint
    this.product = options.product
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  private async post<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Awaited<ReturnType<LicenceFetch>>
    let json: Record<string, unknown>
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      json = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok || json.ok === false) {
      throw new LicenceRefusal(
        String(json.message ?? `Request failed (${response.status})`),
        typeof json.reason === 'string' ? json.reason : 'server_error',
        response.status
      )
    }

    // The service hashes the fingerprint it receives and echoes the result.
    // If that disagrees with what check() will recompute locally, the token is
    // bound to something this machine can never reproduce: every later check
    // would return wrong_machine, and no amount of releasing seats would help.
    // Far better to fail here, once, with a reason.
    if (typeof json.machine === 'string' && json.machine !== machineHash(this.fingerprint)) {
      throw new Error(
        'Machine fingerprint mismatch: the service recorded a different hash than this app ' +
          'computes. Send the raw fingerprint as `machine` — the service hashes it. Do not ' +
          'pre-hash it, and use the same fingerprint here and in check().'
      )
    }

    return json as T
  }

  activate(key: string, label?: string) {
    return this.post<TokenReply>('/api/licence/activate', {
      key,
      machine: this.fingerprint,
      label,
      product: this.product,
    })
  }

  heartbeat(key: string) {
    return this.post<TokenReply>('/api/licence/heartbeat', {
      key,
      machine: this.fingerprint,
      product: this.product,
    })
  }

  deactivate(key: string) {
    return this.post('/api/licence/deactivate', { key, machine: this.fingerprint })
  }

  startTrial(email: string, name?: string) {
    return this.post<TokenReply>('/api/licence/trial', {
      product: this.product,
      email,
      name,
      machine: this.fingerprint,
    })
  }
}
