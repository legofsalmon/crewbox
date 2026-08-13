import { createPublicKey, createHash, verify as verifySignature } from 'node:crypto'

/**
 * Deciding whether a downloaded build is really ours.
 *
 * This is the most dangerous thing crewbox does. Everything else the box
 * touches it either reads (lighting, video, the media network) or serves to
 * a crew. This takes a file off the internet and, one commit from now, runs
 * it as the box. Get it wrong and the updater is a way into every festival
 * box in the field, all at once, from one compromised account.
 *
 * So there are two gates and they are not the same gate:
 *
 *  - **The digest** says the bytes arrived intact. It comes from the release
 *    manifest, and on its own it proves nothing about who wrote the manifest.
 *  - **The signature** says the manifest came from somebody holding a release
 *    key. That is the one that matters. It is checked against keys compiled
 *    into this binary, so an attacker who owns the GitHub account can publish
 *    whatever they like and no box will run it.
 *
 * The manifest is `sha256sum` format on purpose: the same file a human can
 * check by hand with `sha256sum -c`, which is what makes the chain auditable
 * by somebody who does not trust this code either.
 */

/**
 * Public halves of the keys allowed to sign a release.
 *
 * **A set, not a key, and that is the whole point.** A box running v0.17
 * carries v0.17's idea of what is trusted, for ever. With a single key baked
 * in there is no way to ever change it: rotate, and every box already in the
 * field rejects every future release — the updater becomes the one thing that
 * cannot be updated. With a set, a new key ships in release N, boxes pick it
 * up as they update, and releases can move to it once enough of the field has
 * caught up. Old keys stay listed until nothing that old is still running.
 *
 * Adding a key here is a decision about who may take over every crewbox in
 * existence. It deserves a conversation, not a commit.
 */
export const TRUSTED_KEYS: readonly string[] = [
  // crewbox release key 1, minted 2026-08-13. Private half lives in the
  // RELEASE_SIGNING_KEY secret on legofsalmon/crewbox and nowhere else in
  // this repository.
  '-----BEGIN PUBLIC KEY-----\n' +
    'MCowBQYDK2VwAyEAlijcvU5IzE/rENDWR5WEUdAZ6K2EKjLV61vEDzBseuw=\n' +
    '-----END PUBLIC KEY-----\n',
]

/** What a parsed manifest gives you: filename to lowercase hex digest. */
export type Manifest = Map<string, string>

export class VerifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerifyError'
  }
}

/**
 * How large a manifest may be before it is obviously not one.
 *
 * Eight lines of eighty characters is the real thing. A megabyte claiming to
 * be a manifest is either broken or hostile, and either way parsing it is
 * work done on behalf of somebody who does not deserve it.
 */
export const MAX_MANIFEST_BYTES = 64 * 1024

/**
 * Parse `sha256sum` output.
 *
 * Deliberately strict. A line this cannot read is a rejection rather than a
 * skip: a manifest with a mangled entry is a manifest somebody should look
 * at, and silently ignoring the unreadable half is how a file ends up
 * "verified" against a digest that was never checked.
 */
export function parseManifest(text: string): Manifest {
  if (text.length > MAX_MANIFEST_BYTES) throw new VerifyError('manifest is implausibly large')
  const out: Manifest = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    // `<64 hex>  <name>` — two spaces is what sha256sum writes; one, or a
    // `*` binary marker, is what other tools write. Accept all three.
    const match = /^([0-9a-f]{64})\s+\*?(\S.*)$/i.exec(line)
    if (!match) throw new VerifyError(`unreadable line in the manifest: ${line.slice(0, 40)}`)
    const name = match[2].trim()
    if (out.has(name)) throw new VerifyError(`${name} is listed twice in the manifest`)
    out.set(name, match[1].toLowerCase())
  }
  if (out.size === 0) throw new VerifyError('the manifest is empty')
  return out
}

/**
 * Is this manifest signed by a key we trust?
 *
 * Every trusted key is tried, because the whole point of a set is that a
 * release may be signed by any of them. Returns which one matched, so a log
 * can say *which* key signed a build — useful when a rotation is half done
 * and you want to know what a given box actually accepted.
 *
 * Never throws on a bad signature: an unsigned or wrongly-signed manifest is
 * an answer, not an exception, and the caller must handle it either way.
 */
export function verifyManifest(
  manifest: string,
  signatureBase64: string,
  keys: readonly string[] = TRUSTED_KEYS
): { ok: true; keyIndex: number } | { ok: false; reason: string } {
  if (keys.length === 0) {
    return { ok: false, reason: 'this build trusts no release keys' }
  }
  let signature: Buffer
  try {
    signature = Buffer.from(signatureBase64.trim(), 'base64')
  } catch {
    return { ok: false, reason: 'the signature is not base64' }
  }
  // ed25519 signatures are exactly 64 bytes. Anything else is not one, and
  // checking here keeps a malformed blob away from the crypto layer.
  if (signature.length !== 64) {
    return { ok: false, reason: `the signature is ${signature.length} bytes, not 64` }
  }

  const data = Buffer.from(manifest, 'utf8')
  for (const [index, pem] of keys.entries()) {
    try {
      if (verifySignature(null, data, createPublicKey(pem), signature)) {
        return { ok: true, keyIndex: index }
      }
    } catch {
      // A key this build cannot parse is a bug in the build, not grounds to
      // stop checking the others.
    }
  }
  return { ok: false, reason: 'not signed by any key this build trusts' }
}

/** SHA-256 of a buffer, lowercase hex — the form the manifest uses. */
export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * The full check on one downloaded file.
 *
 * Ordered so the cheap, local failure comes first: an asset missing from the
 * manifest is a mistake in the release, and saying so is more use than "the
 * digest did not match".
 */
export function checkAsset(
  name: string,
  digest: string,
  manifest: Manifest
): { ok: true } | { ok: false; reason: string } {
  const expected = manifest.get(name)
  if (!expected) return { ok: false, reason: `${name} is not in the signed manifest` }
  if (expected !== digest.toLowerCase()) {
    return { ok: false, reason: `${name} does not match the digest in the signed manifest` }
  }
  return { ok: true }
}

/**
 * The asset a box on this platform wants, given a release version.
 *
 * Names match what the release workflow stamps. macOS takes the `.dmg`: it is
 * the signed, notarised, universal one, and the bare `crewbox-darwin-*`
 * binaries exist for people who want them rather than for the updater.
 */
export function assetFor(
  version: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (platform === 'linux') return `crewbox-linux-x64-${version}`
  if (platform === 'win32') return `crewbox-win32-x64-${version}.exe`
  if (platform === 'darwin') return `Crewbox-${version}.dmg`
  return null
}

/** The manifest and its detached signature, as the release publishes them. */
export function manifestNames(version: string): { manifest: string; signature: string } {
  return { manifest: `SHA256SUMS-${version}`, signature: `SHA256SUMS-${version}.sig` }
}
