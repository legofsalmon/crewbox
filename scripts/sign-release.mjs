#!/usr/bin/env node
// Write and sign the release manifest.
//
//   node scripts/sign-release.mjs <dir> <version>
//
// Reads every file in <dir>, writes SHA256SUMS-<version> in the format
// `sha256sum` produces, and signs it with the key in RELEASE_SIGNING_KEY.
// The signature goes beside it as SHA256SUMS-<version>.sig, base64.
//
// One signature covers every asset, which is why the box only ever verifies
// two small files however many platforms a release carries. It is also the
// format a human can check without trusting any of our code:
//
//   sha256sum -c SHA256SUMS-v0.18.0
//
// Fails loudly and stops the release when the key is missing. A release that
// quietly shipped unsigned would be worse than one that did not ship: boxes
// would refuse it, and the reason would be four steps away from the cause.

import { createHash, createPrivateKey, sign } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [dir, version] = process.argv.slice(2)
if (!dir || !version) {
  console.error('usage: node scripts/sign-release.mjs <dir> <version>')
  process.exit(1)
}

const pem = process.env.RELEASE_SIGNING_KEY
if (!pem || pem.trim() === '') {
  console.error(
    '::error::RELEASE_SIGNING_KEY is not set — refusing to publish an unsigned release.'
  )
  console.error('Mint one with scripts/release-key.mjs, then add it as a repo secret.')
  console.error('See docs/UPDATING.md.')
  process.exit(1)
}

const manifestName = `SHA256SUMS-${version}`
const signatureName = `${manifestName}.sig`

// Sorted, so the manifest is byte-identical for identical inputs regardless
// of the order the filesystem hands them back. A signature over a file whose
// line order varies is a signature nobody can reproduce by hand.
const files = readdirSync(dir)
  .filter((name) => name !== manifestName && name !== signatureName)
  .filter((name) => statSync(join(dir, name)).isFile())
  .sort()

if (files.length === 0) {
  console.error('::error::nothing to sign in ' + dir)
  process.exit(1)
}

const lines = files.map((name) => {
  const digest = createHash('sha256')
    .update(readFileSync(join(dir, name)))
    .digest('hex')
  // Two spaces: what sha256sum writes, and what `sha256sum -c` expects.
  return `${digest}  ${name}`
})
// Trailing newline, again because that is what sha256sum produces and the
// signature covers the bytes exactly.
const manifest = lines.join('\n') + '\n'

let signature
try {
  signature = sign(null, Buffer.from(manifest, 'utf8'), createPrivateKey(pem)).toString('base64')
} catch (err) {
  console.error(`::error::could not sign with RELEASE_SIGNING_KEY: ${err.message}`)
  console.error('The secret should be the whole PEM, "-----BEGIN PRIVATE KEY-----" and all.')
  process.exit(1)
}

writeFileSync(join(dir, manifestName), manifest)
writeFileSync(join(dir, signatureName), signature + '\n')

console.log(`signed ${files.length} assets into ${manifestName}`)
for (const line of lines) console.log(`  ${line}`)
