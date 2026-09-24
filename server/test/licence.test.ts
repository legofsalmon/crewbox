import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PUBLIC_KEY_HEX, check, machineHash, verify, type Status } from '../src/licence/sdk.ts'
import {
  LICENCE_POLICY,
  PRODUCT,
  decide,
  foreignKeyHint,
  isRestricted,
  keyConfigured,
  licenceEffects,
  tidyKey,
  type LicencePolicy,
} from '../src/licence/decide.ts'
import { parseMachineGuid, readFingerprint } from '../src/licence/fingerprint.ts'

/**
 * The offline half of licensing, against the vendor's own vectors.
 *
 * `fixtures/licence-vectors.json` is `clients/vectors.json` from the
 * letissier.ie repo, verbatim — "every SDK must agree with these". It is
 * signed by a test key included in the file, and every token in it is for
 * `vizz`, which is exactly why the product is a parameter to `decide()`
 * rather than a constant: the vectors drive the tests while the box checks
 * for `crewbox`.
 */

interface Vectors {
  publicKeyHex: string
  fingerprint: string
  machineHash: string
  now: number
  claims: { product: string; maintUntil: number; exp: number; iat: number }
  tokens: Record<'valid' | 'validTrial' | 'tampered' | 'wrongKey' | 'malformed', string>
  entitlement: { buildDate: number; expect: Status; why: string }[]
  lease: { at: number; expect: Status; why: string }[]
  trialLease: { at: number; expect: Status; why: string }[]
}

const V = JSON.parse(
  readFileSync(new URL('./fixtures/licence-vectors.json', import.meta.url), 'utf8')
) as Vectors

/** Inside the vectors' update window, so only the lease decides. */
const IN_WINDOW = V.entitlement[0].buildDate

const sdk = (token: string, over: { buildDate?: number; now?: number; fp?: string } = {}) =>
  check({
    token,
    fingerprint: over.fp ?? V.fingerprint,
    buildDate: over.buildDate ?? IN_WINDOW,
    now: over.now ?? V.now,
    publicKeyHex: V.publicKeyHex,
  }).status

const decided = (token: string, product = V.claims.product, over: { now?: number } = {}) =>
  decide({
    token,
    fingerprint: V.fingerprint,
    buildDate: IN_WINDOW,
    now: over.now ?? V.now,
    publicKeyHex: V.publicKeyHex,
    product,
  }).status

describe('the vendor SDK agrees with the published vectors', () => {
  it('verifies the good tokens and nothing else', () => {
    expect(verify(V.tokens.valid, V.publicKeyHex)).not.toBeNull()
    expect(verify(V.tokens.validTrial, V.publicKeyHex)).not.toBeNull()
    expect(verify(V.tokens.tampered, V.publicKeyHex), 'payload edited after signing').toBeNull()
    expect(verify(V.tokens.wrongKey, V.publicKeyHex), 'signed by an untrusted key').toBeNull()
    expect(verify(V.tokens.malformed, V.publicKeyHex)).toBeNull()
  })

  it('hashes the fingerprint the way the service does', () => {
    expect(machineHash(V.fingerprint)).toBe(V.machineHash)
    // trimmed, and only trimmed — case is the caller's to keep stable
    expect(machineHash(`  ${V.fingerprint}\n`)).toBe(V.machineHash)
    expect(machineHash(V.fingerprint.toLowerCase())).not.toBe(V.machineHash)
  })

  it('reads the update window inclusively of its deadline', () => {
    for (const row of V.entitlement) {
      expect(sdk(V.tokens.valid, { buildDate: row.buildDate }), row.why).toBe(row.expect)
    }
  })

  it('treats a lapsed lease as a check-in on a purchase and the end of a trial', () => {
    for (const row of V.lease)
      expect(sdk(V.tokens.valid, { now: row.at }), row.why).toBe(row.expect)
    for (const row of V.trialLease) {
      // The trial's maintUntil is its end, so a build from before it is used.
      expect(sdk(V.tokens.validTrial, { now: row.at, buildDate: V.claims.iat }), row.why).toBe(
        row.expect
      )
    }
  })

  it('rejects the bad tokens as invalid, whatever the clock says', () => {
    for (const token of [V.tokens.tampered, V.tokens.wrongKey, V.tokens.malformed]) {
      expect(sdk(token)).toBe('invalid')
    }
  })

  it('says wrong_machine for another fingerprint, and keeps the claims for the panel', () => {
    const verdict = check({
      token: V.tokens.valid,
      fingerprint: 'SOME-OTHER-BOX',
      buildDate: IN_WINDOW,
      now: V.now,
      publicKeyHex: V.publicKeyHex,
    })
    expect(verdict.status).toBe('wrong_machine')
    expect(verdict.claims?.machine).toBe(V.machineHash)
  })

  it('lapses the lease at exp, not a second after', () => {
    expect(sdk(V.tokens.valid, { now: V.claims.exp - 1 })).toBe('active')
    expect(sdk(V.tokens.valid, { now: V.claims.exp })).toBe('check_in_required')
  })
})

describe('decide(): the SDK plus the product check it leaves to the app', () => {
  it('agrees with the SDK when the product matches', () => {
    expect(decided(V.tokens.valid)).toBe('active')
    expect(decided(V.tokens.valid, 'vizz', { now: V.lease[1].at })).toBe('check_in_required')
  })

  it("refuses another product's token outright — a Vizz licence is not a Crewbox one", () => {
    expect(PRODUCT).toBe('crewbox')
    expect(decided(V.tokens.valid, PRODUCT)).toBe('invalid')
    expect(decided(V.tokens.validTrial, PRODUCT)).toBe('invalid')
    // even when it is another machine's too: product first, so no claims leak
    const v = decide({
      token: V.tokens.valid,
      fingerprint: 'SOME-OTHER-BOX',
      buildDate: IN_WINDOW,
      now: V.now,
      publicKeyHex: V.publicKeyHex,
      product: PRODUCT,
    })
    expect(v).toEqual({ status: 'invalid' })
  })

  it('decides no token at all as invalid', () => {
    expect(decided('')).toBe('invalid')
  })

  it('verifies nothing with a placeholder or empty key', () => {
    for (const key of ['', 'REPLACE_WITH_YOUR_PUBLIC_KEY_HEX', '00', 'aa'.repeat(32)]) {
      const v = decide({
        token: V.tokens.valid,
        fingerprint: V.fingerprint,
        buildDate: IN_WINDOW,
        now: V.now,
        publicKeyHex: key,
        product: 'vizz',
      })
      expect(v.status, `key ${JSON.stringify(key)}`).toBe('invalid')
    }
  })
})

const STATUSES: Status[] = [
  'active',
  'update_required',
  'check_in_required',
  'expired',
  'wrong_machine',
  'invalid',
]
const POLICIES: LicencePolicy[] = ['open', 'watermark', 'lock']

describe('the policy table', () => {
  /** Every status × policy, written out so a change to the rule is a change here. */
  const TABLE: Record<LicencePolicy, Record<Status, boolean>> = {
    open: {
      active: false,
      update_required: false,
      check_in_required: false,
      expired: false,
      wrong_machine: false,
      invalid: false,
    },
    watermark: {
      active: false,
      update_required: false,
      check_in_required: false,
      expired: true,
      wrong_machine: true,
      invalid: true,
    },
    lock: {
      active: false,
      update_required: false,
      check_in_required: false,
      expired: true,
      wrong_machine: true,
      invalid: true,
    },
  }

  it('restricts exactly the unusable statuses, and only when the policy cares', () => {
    for (const policy of POLICIES) {
      for (const status of STATUSES) {
        expect(isRestricted(status, policy, true), `${status} under ${policy}`).toBe(
          TABLE[policy][status]
        )
      }
    }
  })

  it('restricts nothing at all on a build that cannot verify', () => {
    for (const policy of POLICIES) {
      for (const status of STATUSES) {
        expect(isRestricted(status, policy, false), `${status} under ${policy}`).toBe(false)
      }
    }
  })

  it('never lets update_required or check_in_required cost anything', () => {
    for (const policy of POLICIES) {
      for (const status of ['update_required', 'check_in_required'] as const) {
        expect(licenceEffects(status, policy, true)).toEqual({
          restricted: false,
          watermark: false,
          locked: false,
        })
      }
    }
  })

  it('marks under watermark, and marks and locks under lock', () => {
    expect(licenceEffects('invalid', 'open', true)).toEqual({
      restricted: false,
      watermark: false,
      locked: false,
    })
    expect(licenceEffects('invalid', 'watermark', true)).toEqual({
      restricted: true,
      watermark: true,
      locked: false,
    })
    expect(licenceEffects('invalid', 'lock', true)).toEqual({
      restricted: true,
      watermark: true,
      locked: true,
    })
  })

  it('a lapsed trial is expired, restricted under watermark and lock, never under open', () => {
    const lapsed = decided(V.tokens.validTrial, 'vizz', { now: V.trialLease[0].at })
    expect(lapsed).toBe('expired')
    expect(isRestricted(lapsed, 'watermark', true)).toBe(true)
    expect(isRestricted(lapsed, 'lock', true)).toBe(true)
    expect(isRestricted(lapsed, 'open', true)).toBe(false)
  })

  it('ships as lock ("trial, then lock"), with the live key compiled in', () => {
    expect(LICENCE_POLICY).toBe('lock')
    expect(keyConfigured(PUBLIC_KEY_HEX)).toBe(true)
    expect(PUBLIC_KEY_HEX).toBe('1fca6c21f2eb7963fd646272a731a41a191d3a4cda839e295c5cda67978fcc85')
    expect(keyConfigured('REPLACE_WITH_YOUR_PUBLIC_KEY_HEX')).toBe(false)
    expect(keyConfigured('')).toBe(false)
  })
})

describe('keys as typed', () => {
  it('tidies without folding — the service folds', () => {
    expect(tidyKey('  lt-crew-abcd -efgh-ijkl ')).toBe('LT-CREW-ABCD-EFGH-IJKL')
  })

  it("hints at another product's key from its first group", () => {
    expect(foreignKeyHint('LT-V1ZZ-K7M2-9PQR-4XTC')).toMatch(/Vizz/)
    expect(foreignKeyHint('lt-data-aaaa-bbbb-cccc')).toMatch(/Datamosh/)
    // folded before comparing, as the service would: I/L → 1
    expect(foreignKeyHint('LT-LLGH-AAAA-BBBB-CCCC')).toMatch(/Light/)
    expect(foreignKeyHint('yewe-aaaa-bbbb-cccc')).toMatch(/Yewee/)
    expect(foreignKeyHint('LT-CREW-AAAA-BBBB-CCCC')).toBeNull()
    expect(
      foreignKeyHint('LT-ZZZZ-AAAA-BBBB-CCCC'),
      'unknown tags are the service’s call'
    ).toBeNull()
  })
})

describe('the machine id', () => {
  it('reads the Windows GUID out of reg.exe', () => {
    const out =
      '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n' +
      '    MachineGuid    REG_SZ    6f1c2a4e-1b2c-4d5e-8f90-abcdef012345\r\n\r\n'
    expect(parseMachineGuid(out)).toBe('6f1c2a4e-1b2c-4d5e-8f90-abcdef012345')
    expect(parseMachineGuid('ERROR: The system was unable to find the specified')).toBeNull()
  })

  it('is stable between reads, raw rather than hashed', () => {
    const a = readFingerprint()
    if (a === null) return // a container with no machine id: nothing to assert
    expect(readFingerprint()).toBe(a)
    expect(a).toBe(a.trim())
  })
})
