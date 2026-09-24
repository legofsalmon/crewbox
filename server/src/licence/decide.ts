/**
 * What a licence status costs this box — pure, no I/O, no clock of its own.
 *
 * Everything here is a function of its arguments, which is what lets the
 * vendor's published vectors drive the tests and what keeps the one decision
 * that matters (is this box restricted, and how) in one place.
 *
 * The rule the whole feature is built around: **nothing licence-related ever
 * touches crew comms.** Chat, voice, the docs relay and every department
 * module work the same on an unlicensed box as on a licensed one, under every
 * policy. The most a policy can do is mark the admin console and the drawer,
 * or refuse to configure a *new* event. A running event is never interrupted.
 */
import { check, verify, type Claims, type Status, type Verdict } from './sdk.ts'

/** This app's id with the licence service. Tokens for any other product are invalid here. */
export const PRODUCT = 'crewbox'

/**
 * What an unlicensed box does.
 *
 * - `open`: nothing. Exactly as before this existed; the Licence section says
 *   "Unlicensed" and offers a key or a trial, and that is all.
 * - `watermark`: a persistent banner in the admin console and a small
 *   "Unlicensed" line in the crew drawer. Everything keeps working.
 * - `lock`: the watermark, plus the admin console refuses to set up or
 *   configure an event (first-run setup, event name, Wi-Fi hint, networks)
 *   until a trial or key is entered. Crew-facing features keep working for
 *   anyone already set up, and security controls — the event PIN and the
 *   admin password — are never locked, because a licence must not be the
 *   reason somebody cannot shut a stranger out.
 */
export type LicencePolicy = 'open' | 'watermark' | 'lock'

/**
 * THE switch. One line to flip.
 *
 * `lock` — "trial, then lock" — is the owner's decision: a box that has never
 * had a trial or a key cannot set up or configure an event, and a trial that
 * ends locks configuration again. It never reaches the crew: chat, voice,
 * files and every department module keep working on a locked box, and so do
 * the event PIN, the admin password, moderation, crew PIN resets, updates and
 * the export. `watermark` and `open` remain one word away.
 */
export const LICENCE_POLICY: LicencePolicy = 'lock'

/** A build can verify only with a 32-byte key; anything else verifies nothing. */
export function keyConfigured(publicKeyHex: string): boolean {
  return /^[0-9a-f]{64}$/i.test(publicKeyHex)
}

/**
 * Is this status restricted under this policy?
 *
 * Mirrors Light's `blocks_new_session`, including its hard-won reasoning:
 *
 * - `invalid` — no licence, one that will not verify, or one for another
 *   product. Restricted, or starting a trial would be strictly worse than
 *   never starting one.
 * - `expired` — the trial is over. That is the whole meaning of a trial.
 * - `wrong_machine` — the token belongs to another box. Copying the database
 *   to a second box is the obvious way around any of this.
 *
 * Deliberately NOT restricted:
 *
 * - `update_required` — a bought licence is permanent; only the update
 *   entitlement lapses, and that costs newer builds, never this one.
 * - `check_in_required` — a paying customer whose lease lapsed, which on a
 *   festival box usually means a fortnight in a field. It asks for a
 *   heartbeat; it never ends anything.
 *
 * And a build with no usable verifying key restricts nothing at all: shipping
 * one would otherwise brick every copy of it and look like a decision.
 */
export function isRestricted(status: Status, policy: LicencePolicy, verifies: boolean): boolean {
  if (!verifies) return false
  if (policy === 'open') return false
  return status === 'invalid' || status === 'expired' || status === 'wrong_machine'
}

export interface LicenceEffects {
  /** No usable licence, and the policy cares. */
  restricted: boolean
  /** Show the admin banner and the drawer line. */
  watermark: boolean
  /** Refuse to set up or configure an event. */
  locked: boolean
}

/** What a restriction means in practice. Derived only from `isRestricted`. */
export function licenceEffects(
  status: Status,
  policy: LicencePolicy,
  verifies: boolean
): LicenceEffects {
  const restricted = isRestricted(status, policy, verifies)
  return { restricted, watermark: restricted, locked: restricted && policy === 'lock' }
}

/**
 * The claims a decision relies on, present and the right type.
 *
 * Only ever reached past a good signature, so this is not about forgery — it
 * is about the vendor SDK doing arithmetic on a missing `exp` and getting
 * NaN, which compares false against everything and reads as `active`.
 */
function wellFormed(claims: Claims): boolean {
  return (
    typeof claims.product === 'string' &&
    typeof claims.machine === 'string' &&
    typeof claims.edition === 'string' &&
    typeof claims.key === 'string' &&
    Number.isFinite(claims.exp) &&
    Number.isFinite(claims.maintUntil)
  )
}

export interface DecideInput {
  token: string | undefined
  fingerprint: string
  /** When this build was released, unix seconds. Baked in — see version.ts. */
  buildDate: number
  /** Unix seconds. */
  now: number
  publicKeyHex: string
  /**
   * A parameter rather than PRODUCT so the vendor's vectors (issued for
   * `vizz`) can drive the tests while the box checks for `crewbox`. It is a
   * real check, not scaffolding: a Datamosh token must not license a box.
   */
  product: string
}

/**
 * The decision, offline: the vendor's `check()` plus the product check the
 * vendor SDKs leave to the app. The only caller of `check()` in crewbox.
 */
export function decide(input: DecideInput): Verdict {
  if (!input.token) return { status: 'invalid' }
  const verdict = check({
    token: input.token,
    fingerprint: input.fingerprint,
    buildDate: input.buildDate,
    now: input.now,
    publicKeyHex: input.publicKeyHex,
  })
  if (!verdict.claims) return verdict
  if (!wellFormed(verdict.claims)) return { status: 'invalid' }
  if (verdict.claims.product.toLowerCase() !== input.product.toLowerCase()) {
    return { status: 'invalid' }
  }
  return verdict
}

/** The product a validly signed token was issued for, whatever this box is. */
export function tokenProduct(token: string, publicKeyHex: string): string | null {
  const claims = verify(token, publicKeyHex)
  return claims && typeof claims.product === 'string' ? claims.product : null
}

/** Product tags in the key's first group, for the "that's a key for …" hint. */
const PRODUCT_TAGS: Record<string, string> = {
  V1ZZ: 'Vizz',
  CREW: 'Crewbox',
  DATA: 'Datamosh',
  '11GH': 'Light',
  YEWE: 'Yewee',
}

/** Product names by id, for the same hint on a pasted token. */
export const PRODUCT_NAMES: Record<string, string> = {
  vizz: 'Vizz',
  crewbox: 'Crewbox',
  datamosh: 'Datamosh',
  light: 'Light',
  yewee: 'Yewee',
}

/**
 * Tidy a typed key for the wire: trimmed, spaces gone, upper case.
 *
 * Nothing more. The service folds I/L→1, O→0 and U→V and accepts a missing
 * `LT-` itself, and the key is otherwise opaque — a second, local copy of that
 * folding is one more place for the two ends to disagree.
 */
export function tidyKey(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase()
}

/**
 * "That's a key for Vizz", when the first group says so. Null when it names
 * this product, or nothing recognisable — the service is the authority, and
 * this is only a friendlier sentence before asking it.
 */
export function foreignKeyHint(key: string): string | null {
  const body = tidyKey(key).replace(/^LT-?/, '')
  const tag = body.slice(0, 4).replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V')
  const name = PRODUCT_TAGS[tag]
  if (!name || tag === 'CREW') return null
  return `That looks like a key for ${name}, not Crewbox.`
}
