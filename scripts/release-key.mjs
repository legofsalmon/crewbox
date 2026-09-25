#!/usr/bin/env node
// Mint the release signing key. Run once, on a machine you control.
//
//   node scripts/release-key.mjs
//
// Produces an ed25519 keypair: the private half signs releases and must never
// leave your keeping, the public half goes into TRUSTED_KEYS in
// server/src/update/verify.ts and ships inside every box, and into the apps'
// copies of it, which check the screens a box hands them (docs/UPDATING.md).
//
// Why ed25519 rather than the RSA key you already have for Android: the
// signature is 64 bytes, verification needs nothing but node:crypto, and
// there is exactly one way to use it — no algorithm agility means no
// algorithm-confusion bug. This key signs a manifest, nothing else.
//
// **What losing it costs, and what leaking it costs, are different.**
// Losing it means minting a new one, adding it to TRUSTED_KEYS, and waiting
// for the field to catch up before you can sign with it alone — annoying,
// recoverable, which is the entire reason the box trusts a set. Leaking it
// means whoever has it can publish a build that every crewbox in existence
// will accept as genuine, and screens every crew phone's app will run. Treat
// it like the Android keystore: password manager, offline, never in the repo.

import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync, existsSync } from 'node:fs'

const PRIVATE = 'crewbox-release-key.pem'
const PUBLIC = 'crewbox-release-key.pub.pem'

for (const path of [PRIVATE, PUBLIC]) {
  if (existsSync(path)) {
    console.error(`${path} already exists here. Move it aside first — overwriting a release`)
    console.error('key would strand every box that trusts it.')
    process.exit(1)
  }
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
// The apps carry each key as its 32 raw bytes, not as a PEM.
const publicRaw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64')

// 0o600 before anything is written to it, not after: a private key that spent
// even a moment world-readable is a private key on a shared machine.
writeFileSync(PRIVATE, privatePem, { mode: 0o600 })
writeFileSync(PUBLIC, publicPem)

console.log(`
Two files, here:

  ${PRIVATE}   the private half — back this up, never commit it
  ${PUBLIC}    the public half

Next:

1. Add the public key to TRUSTED_KEYS in server/src/update/verify.ts:

${publicPem
  .trim()
  .split('\n')
  .map((line) => `     '${line}\\n' +`)
  .join('\n')}

   (or paste the PEM as a template literal — whichever reads better)

   and the same key, as its 32 bytes in base64, to the apps' copies of that
   list, in the same order: TRUSTED_KEYS in
   native/android/app/src/main/java/com/colmhewson/crewbox/Screens.java and
   trustedKeys in native/ios/App/App/ScreensPlugin.swift.

     "${publicRaw}",

   A server test fails until the three agree. An app without the key runs
   its own screens rather than the ones a box signed with it hands it.

2. Add the private key as a repo secret on legofsalmon/crewbox:

     RELEASE_SIGNING_KEY    the whole of ${PRIVATE}, newlines and all

3. Back up ${PRIVATE} and delete it from this directory.

Until step 1 lands in a release, boxes built from that release trust no keys
and will refuse every download — which is the correct behaviour for a
verifier with nothing to trust, and the reason this is worth doing before
the install half exists rather than after.
`)
