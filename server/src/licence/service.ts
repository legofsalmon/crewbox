/**
 * The box's licence: where it is kept, the four calls to the licence service,
 * and the daily check-in.
 *
 * The licence belongs to the BOX — the server — and never to a crew phone. One
 * seat, one machine id, and a token that nothing replicates to a device: it
 * lives in the settings table beside the LiveKit secret and the admin
 * password hash, which the admin panel reads and the crew never see.
 *
 * Three rules this file exists to keep:
 *
 * 1. **Never on the startup path, never in the way of comms.** Startup reads a
 *    cached token and decides offline. Every network call here is either an
 *    admin pressing a button or a timer that is unref'd, starts a minute after
 *    the box is serving, and swallows its own failures.
 * 2. **Offline is the normal state of a festival box.** An unreachable
 *    service keeps the cached answer, and offline activation — the request
 *    code shown, a token pasted back — is a first-class way in, not a
 *    fallback. A box can be licensed without ever touching the internet.
 * 3. **Never store a token this box cannot verify.** The service echoes the
 *    hash it recorded; if that is not ours, or the token decides as another
 *    machine's or another product's, nothing is written.
 */
import { hostname } from 'node:os'
import {
  LicenceClient,
  LicenceRefusal,
  PUBLIC_KEY_HEX,
  machineHash,
  type Claims,
  type LicenceFetch,
  type Status,
  type TokenReply,
  type Verdict,
} from './sdk.ts'
import {
  LICENCE_POLICY,
  PRODUCT,
  PRODUCT_NAMES,
  decide,
  foreignKeyHint,
  keyConfigured,
  licenceEffects,
  tidyKey,
  tokenProduct,
  type LicenceEffects,
  type LicencePolicy,
} from './decide.ts'

/** Settings key holding the licence key. Reaches real boxes — do not rename. */
export const KEY_SETTING = 'licence:key'
/** Settings key holding the current signed token. Reaches real boxes — do not rename. */
export const TOKEN_SETTING = 'licence:token'

/** Where an owner signs in to move a seat or fetch an offline token. */
export const MANAGE_URL = 'https://letissier.ie/account'
export const SERVICE_URL = 'https://letissier.ie'

/**
 * How long after startup the first check-in runs. A box starting up is doing
 * what a crew is waiting on; asking about its licence is not one of those.
 */
export const FIRST_CHECK_IN_DELAY_MS = 60_000
/**
 * How often to *try*. Hourly rather than daily because a festival box sees the
 * internet in short windows — an hour at load-in on somebody's hotspot — and a
 * daily attempt would usually miss them. A success holds for a day, so a box
 * with a steady uplink still checks in daily, not hourly.
 */
export const CHECK_IN_ATTEMPT_MS = 60 * 60_000
export const CHECK_IN_EVERY_MS = 24 * 60 * 60_000
/**
 * How often the offline answer is re-read without any network at all, so a
 * trial that ends while the box is running is marked without a restart.
 */
export const RECHECK_MS = 60 * 60_000

export interface SettingsIo {
  getSetting: (key: string) => string | undefined
  setSetting: (key: string, value: string) => void
}

/**
 * A licence action that did not happen, with an HTTP status the admin panel
 * can show. Never 401 or 403: the panel reads those as "your session" and
 * "your unlock", and a refused licence key is neither.
 */
export class LicenceProblem extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string
  ) {
    super(message)
    this.name = 'LicenceProblem'
  }
}

export interface LicenceServiceOptions {
  settings: SettingsIo
  /** The raw platform id, or null when it could not be read. See fingerprint.ts. */
  fingerprint: string | null
  /** This build's release date, unix seconds. See BUILD_DATE in version.ts. */
  buildDate: number
  publicKeyHex?: string
  policy?: LicencePolicy
  product?: string
  baseUrl?: string
  fetch?: LicenceFetch
  /** Wall clock in ms. Injected by tests. */
  now?: () => number
  /** How this box names itself on the owner's account page. */
  label?: string
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
}

/** What the admin panel's Licence section shows. */
export interface LicenceStatus {
  policy: LicencePolicy
  status: Status
  restricted: boolean
  watermark: boolean
  locked: boolean
  /** False on a build with no usable verifying key — nothing is restricted then. */
  verifies: boolean
  /** The raw fingerprint, for offline activation. Null when unreadable. */
  requestCode: string | null
  /** This box as the service names it: the hash of the request code. */
  machine: string | null
  key: string | null
  licence: {
    edition: string
    name: string | null
    seats: number
    mode: string
    /** ms since epoch; the lease's check-in deadline (a trial's end). */
    checkInBy: number
    /** ms since epoch; builds released up to here are entitled. */
    maintenanceUntil: number
    /** The token's machine, when it is not this one. */
    machine: string
  } | null
  lastCheckIn: { at: number; ok: boolean; error: string | null } | null
  manageUrl: string
  buildDate: number
}

export class LicenceService {
  private readonly options: LicenceServiceOptions
  private readonly publicKeyHex: string
  private readonly policy: LicencePolicy
  private readonly product: string
  private readonly now: () => number
  private readonly listeners: Array<(effects: LicenceEffects) => void> = []
  private lastEffects: LicenceEffects
  private lastCheckIn: { at: number; ok: boolean; error: string | null } | null = null
  private lastSuccess = 0
  private timers: NodeJS.Timeout[] = []
  private checkingIn = false

  constructor(options: LicenceServiceOptions) {
    this.options = options
    this.publicKeyHex = options.publicKeyHex ?? PUBLIC_KEY_HEX
    this.policy = options.policy ?? LICENCE_POLICY
    this.product = options.product ?? PRODUCT
    this.now = options.now ?? (() => Date.now())
    this.lastEffects = this.effects()
  }

  // -- the offline half -------------------------------------------------------

  private stored(key: string): string | undefined {
    // '' is how a released licence is forgotten: the settings table has no
    // delete, and an empty value reads the same as never having had one.
    return this.options.settings.getSetting(key) || undefined
  }

  private decideToken(token: string | undefined): Verdict {
    return decide({
      token,
      fingerprint: this.options.fingerprint ?? '',
      buildDate: this.options.buildDate,
      now: Math.floor(this.now() / 1000),
      publicKeyHex: this.publicKeyHex,
      product: this.product,
    })
  }

  /** The stored token, decided now. No network, nothing that can fail loudly. */
  verdict(): Verdict {
    // No fingerprint means no machine for a token to match. Decided as
    // invalid rather than against the hash of '' — which every other box that
    // cannot read its id would share.
    if (!this.options.fingerprint) return { status: 'invalid' }
    return this.decideToken(this.stored(TOKEN_SETTING))
  }

  effects(): LicenceEffects {
    return licenceEffects(this.verdict().status, this.policy, keyConfigured(this.publicKeyHex))
  }

  /** Be told when the watermark or the lock changes — the hub re-sends config. */
  onChange(listener: (effects: LicenceEffects) => void): void {
    this.listeners.push(listener)
  }

  /** Re-read, and tell listeners if what the box shows has changed. */
  private notify(): void {
    const next = this.effects()
    if (next.watermark === this.lastEffects.watermark && next.locked === this.lastEffects.locked) {
      return
    }
    this.lastEffects = next
    for (const listener of this.listeners) {
      try {
        listener(next)
      } catch {
        // A listener's own bug, not a reason to fail a licence action.
      }
    }
  }

  status(): LicenceStatus {
    const verdict = this.verdict()
    const effects = licenceEffects(verdict.status, this.policy, keyConfigured(this.publicKeyHex))
    const claims: Claims | undefined = verdict.claims
    const fingerprint = this.options.fingerprint
    return {
      policy: this.policy,
      status: verdict.status,
      ...effects,
      verifies: keyConfigured(this.publicKeyHex),
      requestCode: fingerprint,
      machine: fingerprint ? machineHash(fingerprint) : null,
      key: this.stored(KEY_SETTING) ?? null,
      licence: claims
        ? {
            edition: claims.edition,
            name: claims.name ?? null,
            seats: claims.seats,
            mode: claims.mode,
            checkInBy: claims.exp * 1000,
            maintenanceUntil: claims.maintUntil * 1000,
            machine: claims.machine,
          }
        : null,
      lastCheckIn: this.lastCheckIn,
      manageUrl: MANAGE_URL,
      buildDate: this.options.buildDate,
    }
  }

  // -- storing a token --------------------------------------------------------

  /**
   * Keep a token, or refuse it with a reason. The only place either setting
   * is written, so every way in — activation, trial, check-in, a pasted
   * offline token — passes the same checks.
   */
  private keep(token: string, key: string | undefined): Verdict {
    const verdict = this.decideToken(token)
    if (verdict.status === 'wrong_machine') {
      throw new LicenceProblem(
        `That licence was issued for another machine (${verdict.claims?.machine ?? 'unknown'}), ` +
          `but this box is ${this.machine()}. Nothing was stored.`,
        422,
        'wrong_machine'
      )
    }
    if (verdict.status === 'invalid') {
      const product = tokenProduct(token, this.publicKeyHex)
      throw new LicenceProblem(
        product && product.toLowerCase() !== this.product
          ? `That licence is for ${PRODUCT_NAMES[product.toLowerCase()] ?? product}, not Crewbox. Nothing was stored.`
          : "That isn't a licence this box can verify — check it was copied whole. Nothing was stored.",
        422,
        product ? 'wrong_product' : 'invalid'
      )
    }
    this.options.settings.setSetting(TOKEN_SETTING, token)
    const keyToKeep = key ?? verdict.claims?.key
    if (keyToKeep) this.options.settings.setSetting(KEY_SETTING, keyToKeep)
    this.notify()
    return verdict
  }

  private machine(): string {
    return this.options.fingerprint ? machineHash(this.options.fingerprint) : 'unknown'
  }

  /** The service's answer, checked before it is trusted with anything. */
  private accept(reply: TokenReply, key: string | undefined): Verdict {
    if (typeof reply.token !== 'string' || !reply.token) {
      throw new LicenceProblem('The licence service answered without a licence.', 502)
    }
    // Asserted, not just compared when present: a reply that does not say
    // which machine it bound the token to is one this box cannot vouch for.
    if (reply.machine !== this.machine()) {
      throw new LicenceProblem(
        `The licence service recorded this box as ${String(reply.machine)}, but it is ` +
          `${this.machine()}. Nothing was stored — activating again will not help until that is fixed.`,
        502,
        'machine_mismatch'
      )
    }
    return this.keep(reply.token, key)
  }

  // -- the network half -------------------------------------------------------

  private client(): LicenceClient {
    const fingerprint = this.options.fingerprint
    if (!fingerprint) {
      // A hard stop rather than an empty string: activating with one would
      // take a seat under the hash of nothing, which every other box that
      // cannot read its id would also claim.
      throw new LicenceProblem(
        "This box can't read its own machine id, so it can't be licensed. Nothing else is affected.",
        409,
        'no_fingerprint'
      )
    }
    return new LicenceClient({
      baseUrl: this.options.baseUrl ?? SERVICE_URL,
      fingerprint,
      product: this.product,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    })
  }

  /** Turn whatever went wrong on the wire into something an admin can read. */
  private problem(err: unknown): LicenceProblem {
    if (err instanceof LicenceProblem) return err
    if (err instanceof LicenceRefusal) {
      // The service's own sentence, shown as it wrote it. 422 whatever its
      // status was: `revoked` and `expired` arrive as 403, and a 403 here
      // would tell the panel its admin unlock had died.
      return new LicenceProblem(err.message, 422, err.reason)
    }
    if (err instanceof Error && /fingerprint mismatch/i.test(err.message)) {
      return new LicenceProblem(err.message, 502, 'machine_mismatch')
    }
    return new LicenceProblem(
      "Couldn't reach the licence service — this box may be offline, which is fine. " +
        'Use offline activation below, or try again when it has internet.',
      503,
      'unreachable'
    )
  }

  /** Activate a key on this box. Takes one seat; the same box twice renews. */
  async activate(typed: string): Promise<LicenceStatus> {
    const key = tidyKey(typed)
    if (!key) throw new LicenceProblem('Enter a licence key.', 400, 'bad_request')
    const foreign = foreignKeyHint(key)
    // Refused here, before it can take a seat on somebody's other licence.
    if (foreign) throw new LicenceProblem(foreign, 400, 'wrong_product')
    const client = this.client()
    let reply: TokenReply
    try {
      reply = await client.activate(key, this.options.label ?? `Crewbox on ${hostname()}`)
    } catch (err) {
      throw this.problem(err)
    }
    try {
      this.accept(reply, key)
    } catch (err) {
      // A seat was taken for a token this box will not keep. Give it back,
      // best effort, so the owner is not left one seat down for nothing.
      void client.deactivate(key).catch(() => {})
      throw err
    }
    this.recordCheckIn(true, null)
    return this.status()
  }

  /** Start this box's trial. One per machine, ever. */
  async startTrial(email: string, name?: string): Promise<LicenceStatus> {
    if (!email.trim()) throw new LicenceProblem('Enter an email address.', 400, 'bad_email')
    let reply: TokenReply
    try {
      reply = await this.client().startTrial(email.trim(), name?.trim() || undefined)
    } catch (err) {
      throw this.problem(err)
    }
    this.accept(reply, reply.key ? tidyKey(reply.key) : undefined)
    this.recordCheckIn(true, null)
    return this.status()
  }

  /**
   * Offline activation: a token the owner fetched from the account page using
   * this box's request code, pasted in. No network at all.
   */
  acceptToken(pasted: string): LicenceStatus {
    const token = pasted.replace(/\s+/g, '')
    if (!token) throw new LicenceProblem('Paste the licence token.', 400, 'bad_request')
    if (!this.options.fingerprint) this.client() // throws the no-fingerprint problem
    this.keep(token, undefined)
    return this.status()
  }

  /** Check in now. Throws on failure; the background loop swallows it. */
  async checkIn(): Promise<LicenceStatus> {
    const key = this.stored(KEY_SETTING)
    if (!key) {
      throw new LicenceProblem('There is no licence key on this box to check in with.', 409)
    }
    try {
      this.accept(await this.client().heartbeat(key), key)
      this.recordCheckIn(true, null)
      return this.status()
    } catch (err) {
      const problem = this.problem(err)
      this.recordCheckIn(false, problem.message)
      throw problem
    }
  }

  /**
   * Release this box's seat and forget the licence.
   *
   * The call is courtesy and best effort; forgetting is not. A box with no
   * network — most of them, most of the time — must still be able to let go
   * of its licence, and the owner can free the seat from the account page.
   */
  async release(): Promise<{ status: LicenceStatus; released: boolean }> {
    const key = this.stored(KEY_SETTING)
    let released = false
    if (key && this.options.fingerprint) {
      try {
        await this.client().deactivate(key)
        released = true
      } catch {
        // offline, or the service already forgot it — forget it here anyway
      }
    }
    this.options.settings.setSetting(TOKEN_SETTING, '')
    this.options.settings.setSetting(KEY_SETTING, '')
    this.lastCheckIn = null
    this.lastSuccess = 0
    this.notify()
    return { status: this.status(), released }
  }

  private recordCheckIn(ok: boolean, error: string | null): void {
    const at = this.now()
    this.lastCheckIn = { at, ok, error }
    if (ok) this.lastSuccess = at
  }

  // -- timers -----------------------------------------------------------------

  /**
   * Start the background half.
   *
   * `checkIn` false is a box told to make no outbound connections at all
   * (CREWBOX_UPDATE_CHECK=0, and every box run from source): it still
   * re-reads its token hourly, so a trial ending is noticed, but it never
   * reaches for the network by itself. An admin pressing a button is a
   * different matter and always allowed.
   *
   * Every timer is unref'd, so none of this can keep a box from stopping.
   */
  start({ checkIn }: { checkIn: boolean }): void {
    if (this.timers.length) return
    const recheck = setInterval(() => this.notify(), RECHECK_MS)
    recheck.unref()
    this.timers.push(recheck)
    if (!checkIn) return
    const first = setTimeout(() => void this.backgroundCheckIn(), FIRST_CHECK_IN_DELAY_MS)
    first.unref()
    const every = setInterval(() => void this.backgroundCheckIn(), CHECK_IN_ATTEMPT_MS)
    every.unref()
    this.timers.push(first, every)
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  /**
   * One background attempt. Never throws, never logs a warning for being
   * offline — that is the normal state of the box — and skips itself when a
   * check-in already succeeded in the last day.
   */
  async backgroundCheckIn(): Promise<void> {
    if (this.checkingIn) return
    if (!this.stored(KEY_SETTING) || !this.options.fingerprint) return
    if (this.lastSuccess && this.now() - this.lastSuccess < CHECK_IN_EVERY_MS) return
    this.checkingIn = true
    try {
      await this.checkIn()
      this.options.log?.info(`licence: checked in (${this.verdict().status})`)
    } catch {
      // The cached token is still the answer. Recorded for the panel.
    } finally {
      this.checkingIn = false
      this.notify()
    }
  }
}
