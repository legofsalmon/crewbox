import { generateKeyPairSync, sign as signWith } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  MAX_MANIFEST_BYTES,
  VerifyError,
  assetFor,
  checkAsset,
  manifestNames,
  parseManifest,
  sha256,
  verifyManifest,
} from '../src/update/verify.ts'

/**
 * The gate between the internet and a binary this box will run.
 *
 * Every test here is a way of trying to get an unsigned, wrong or substituted
 * file past it. The one that matters most is the empty-key-set case: a build
 * that trusts nothing must reject everything, because the alternative — a
 * verifier that waves things through when it has no opinion — is worse than
 * having no verifier at all.
 */

const keypair = () => generateKeyPairSync('ed25519')
const signManifest = (text: string, key: ReturnType<typeof keypair>['privateKey']) =>
  signWith(null, Buffer.from(text, 'utf8'), key).toString('base64')

const MANIFEST = [
  `${'a'.repeat(64)}  crewbox-linux-x64-v0.18.0`,
  `${'b'.repeat(64)}  crewbox-win32-x64-v0.18.0.exe`,
  `${'c'.repeat(64)}  Crewbox-v0.18.0.dmg`,
].join('\n')

describe('reading a manifest', () => {
  it('reads what sha256sum writes', () => {
    const parsed = parseManifest(MANIFEST)
    expect(parsed.size).toBe(3)
    expect(parsed.get('crewbox-linux-x64-v0.18.0')).toBe('a'.repeat(64))
  })

  it('accepts one space and the binary marker other tools write', () => {
    expect(parseManifest(`${'a'.repeat(64)} name`).get('name')).toBe('a'.repeat(64))
    expect(parseManifest(`${'a'.repeat(64)} *name`).get('name')).toBe('a'.repeat(64))
  })

  it('lowercases the digest, so comparison never depends on case', () => {
    expect(parseManifest(`${'A'.repeat(64)}  name`).get('name')).toBe('a'.repeat(64))
  })

  it('rejects a line it cannot read rather than skipping it', () => {
    // Silently ignoring the unreadable half is how a file ends up "verified"
    // against a digest that was never checked.
    expect(() => parseManifest(`${'a'.repeat(64)}  ok\nnonsense here`)).toThrow(VerifyError)
    expect(() => parseManifest('deadbeef  tooshort')).toThrow(VerifyError)
  })

  it('rejects a file listed twice', () => {
    // Otherwise which digest wins is a property of parser order.
    const dup = `${'a'.repeat(64)}  same\n${'b'.repeat(64)}  same`
    expect(() => parseManifest(dup)).toThrow(/listed twice/)
  })

  it('rejects an empty manifest', () => {
    expect(() => parseManifest('   \n\n')).toThrow(/empty/)
  })

  it('refuses something implausibly large before parsing it', () => {
    const huge = `${'a'.repeat(64)}  x\n`.repeat(MAX_MANIFEST_BYTES)
    expect(() => parseManifest(huge)).toThrow(/implausibly large/)
  })
})

describe('verifying a signature', () => {
  it('accepts a manifest signed by a trusted key', () => {
    const { publicKey, privateKey } = keypair()
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    expect(verifyManifest(MANIFEST, signManifest(MANIFEST, privateKey), [pem])).toEqual({
      ok: true,
      keyIndex: 0,
    })
  })

  it('says which key signed it, so a half-done rotation is legible', () => {
    const older = keypair()
    const newer = keypair()
    const keys = [
      older.publicKey.export({ type: 'spki', format: 'pem' }) as string,
      newer.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    ]
    const result = verifyManifest(MANIFEST, signManifest(MANIFEST, newer.privateKey), keys)
    expect(result).toEqual({ ok: true, keyIndex: 1 })
  })

  it('rejects a manifest signed by a key it does not trust', () => {
    // The whole point: whoever can publish a release cannot, on its own,
    // make a box run it.
    const trusted = keypair()
    const attacker = keypair()
    const pem = trusted.publicKey.export({ type: 'spki', format: 'pem' }) as string
    const result = verifyManifest(MANIFEST, signManifest(MANIFEST, attacker.privateKey), [pem])
    expect(result).toEqual({ ok: false, reason: 'not signed by any key this build trusts' })
  })

  it('rejects a manifest whose contents were changed after signing', () => {
    const { publicKey, privateKey } = keypair()
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    const signature = signManifest(MANIFEST, privateKey)
    const tampered = MANIFEST.replace('a'.repeat(64), 'd'.repeat(64))
    expect(verifyManifest(tampered, signature, [pem]).ok).toBe(false)
  })

  it('refuses everything when the build trusts no keys', () => {
    // A verifier with no opinion must fail closed. The opposite — waving
    // things through until somebody remembers to add a key — is worse than
    // shipping no verifier at all, because it looks like one.
    const { privateKey } = keypair()
    const result = verifyManifest(MANIFEST, signManifest(MANIFEST, privateKey), [])
    expect(result).toEqual({ ok: false, reason: 'this build trusts no release keys' })
  })

  it('rejects a signature that is not the right size', () => {
    const { publicKey } = keypair()
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    expect(verifyManifest(MANIFEST, Buffer.from('short').toString('base64'), [pem])).toEqual({
      ok: false,
      reason: 'the signature is 5 bytes, not 64',
    })
  })

  it('does not throw on junk, however malformed', () => {
    const { publicKey } = keypair()
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    for (const junk of ['', 'not base64 at all!!', '%%%%']) {
      expect(verifyManifest(MANIFEST, junk, [pem]).ok).toBe(false)
    }
  })

  it('keeps checking when one trusted key is unparseable', () => {
    // A broken entry is a bug in the build, not grounds to stop trusting the
    // keys that are fine.
    const { publicKey, privateKey } = keypair()
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    const result = verifyManifest(MANIFEST, signManifest(MANIFEST, privateKey), ['garbage', pem])
    expect(result).toEqual({ ok: true, keyIndex: 1 })
  })
})

describe('checking one asset against the manifest', () => {
  const manifest = parseManifest(MANIFEST)

  it('accepts a file whose digest matches', () => {
    expect(checkAsset('Crewbox-v0.18.0.dmg', 'c'.repeat(64), manifest)).toEqual({ ok: true })
  })

  it('is case-insensitive about the digest it was handed', () => {
    expect(checkAsset('Crewbox-v0.18.0.dmg', 'C'.repeat(64), manifest).ok).toBe(true)
  })

  it('rejects a file that is not in the manifest at all', () => {
    // The substitution attack: publish an extra asset the manifest never
    // covered and hope somebody downloads it.
    const result = checkAsset('crewbox-linux-x64-v0.99.0', 'a'.repeat(64), manifest)
    expect(result).toEqual({
      ok: false,
      reason: 'crewbox-linux-x64-v0.99.0 is not in the signed manifest',
    })
  })

  it('rejects a file whose bytes differ from what was signed', () => {
    expect(checkAsset('Crewbox-v0.18.0.dmg', 'f'.repeat(64), manifest).ok).toBe(false)
  })
})

describe('naming', () => {
  it('picks the right asset per platform', () => {
    expect(assetFor('v0.18.0', 'linux')).toBe('crewbox-linux-x64-v0.18.0')
    expect(assetFor('v0.18.0', 'win32')).toBe('crewbox-win32-x64-v0.18.0.exe')
    // The signed, notarised, universal one — not a bare darwin binary.
    expect(assetFor('v0.18.0', 'darwin')).toBe('Crewbox-v0.18.0.dmg')
  })

  it('has nothing to offer a platform the box is not built for', () => {
    expect(assetFor('v0.18.0', 'freebsd')).toBeNull()
  })

  it('stamps the version into the manifest names, like every other asset', () => {
    // Downloads land in one folder; two files called SHA256SUMS tell nobody
    // which release they describe.
    expect(manifestNames('v0.18.0')).toEqual({
      manifest: 'SHA256SUMS-v0.18.0',
      signature: 'SHA256SUMS-v0.18.0.sig',
    })
  })
})

describe('digests', () => {
  it('agrees with what sha256sum would print', () => {
    // echo -n abc | sha256sum
    expect(sha256(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})
