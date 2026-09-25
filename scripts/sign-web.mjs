#!/usr/bin/env node
// Sign the web screens, once per release.
//
//   node scripts/sign-web.mjs <dist> [version]
//
// Writes WEBSUMS into <dist>, one line per file the screens are made of
// (scripts/web-sums.mjs says which, and why), and signs it with the key in
// RELEASE_SIGNING_KEY: the release key that already signs SHA256SUMS
// (scripts/sign-release.mjs), checked against the same public keys. The
// signature goes beside it as WEBSUMS.sig, base64. Given the release's
// version, the screens must have been built as that release.
//
// The release runs this in a job of its own that installs nothing, so the key
// is never beside a dependency's install script (release.yml, sign-web). CI
// runs it with a key made for the run, to rehearse the rest.
//
// Fails, and stops the release, rather than sign screens a phone would refuse:
// an unsigned or unusable set would leave every app on its own screens, and
// the reason would be a long way from here.

import { createPrivateKey, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SIGNATURE,
  SUMS,
  parseSums,
  problemsWith,
  readInfo,
  screensIn,
  sumsFor,
} from './web-sums.mjs'

const [dir, version] = process.argv.slice(2)
if (!dir) {
  console.error('usage: node scripts/sign-web.mjs <dist> [version]')
  process.exit(1)
}

const fail = (...lines) => {
  for (const line of lines) console.error(`::error::${line}`)
  process.exit(1)
}

const pem = process.env.RELEASE_SIGNING_KEY
if (!pem || pem.trim() === '') {
  fail(
    'RELEASE_SIGNING_KEY is not set — refusing to ship screens no app will run.',
    'It is the same secret scripts/sign-release.mjs uses. See docs/UPDATING.md.'
  )
}

let info
try {
  info = readInfo(dir)
} catch (err) {
  fail(`${err.message} — was ${dir} built with \`npm run build -w web\`?`)
}
// A box says it runs `<its package version>+<commit>`, and an app runs a box's
// screens only when they say the same. Screens built from a web package that
// missed the version bump would be refused by every phone, so refuse them here.
if (version && !info.version.startsWith(`${version.replace(/^v/, '')}+`)) {
  fail(`the screens were built as ${info.version}, not as ${version}. Bump web/package.json too.`)
}

const files = screensIn(dir)
const problems = problemsWith(dir, files)
if (problems.length > 0) fail(...problems)

const sums = sumsFor(dir, files)
// Read back as a phone will read it, which is also what holds the list itself
// to the size a phone takes.
try {
  parseSums(sums)
} catch (err) {
  fail(err.message)
}

let signature
try {
  const key = createPrivateKey(pem)
  // Any other kind of key signs happily, and no box or phone would accept it.
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`it is an ${key.asymmetricKeyType} key, not ed25519`)
  }
  signature = sign(null, Buffer.from(sums, 'utf8'), key).toString('base64')
} catch (err) {
  fail(
    `could not sign with RELEASE_SIGNING_KEY: ${err.message}`,
    'The secret should be the whole PEM, "-----BEGIN PRIVATE KEY-----" and all.'
  )
}

writeFileSync(join(dir, SUMS), sums)
writeFileSync(join(dir, SIGNATURE), signature + '\n')

console.log(`signed ${files.length} files of the ${info.version} screens into ${SUMS}`)
process.stdout.write(sums.replace(/^/gm, '  '))
