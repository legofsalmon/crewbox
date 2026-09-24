import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'

/**
 * The e2e suite's licence signing key — a TEST key, fixed so the runner, its
 * workers and the seed script all agree without passing a secret around.
 *
 * The box under test is told to trust it through CREWBOX_LICENCE_PUBLIC_KEY,
 * which a box *binary* cannot be: scripts/build-box.mjs bakes that variable in
 * at bundle time. It has no standing anywhere else, and the live service has
 * never heard of it.
 */
const SEED = createHash('sha256').update('crewbox e2e licence key — not a real one').digest()

const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]),
  format: 'der',
  type: 'pkcs8',
})

export const E2E_LICENCE_PUBLIC_KEY = (
  createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer
)
  .subarray(-32)
  .toString('hex')

export const E2E_LICENCE_KEY = 'LT-CREW-E2E0-TEST-0000'

/**
 * A token for this box, the way the account page's offline activation issues
 * one: bound to sha256(fingerprint)[:32] and signed over the ASCII of the
 * base64url payload, exactly as the real signer does.
 */
export function mintLicenceToken(fingerprint: string): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      key: E2E_LICENCE_KEY,
      product: 'crewbox',
      edition: 'standard',
      customer: '00000000-0000-4000-8000-000000000e2e',
      name: 'E2E Rig',
      seats: 1,
      maintUntil: now + 365 * 86_400,
      exp: now + 90 * 86_400,
      machine: createHash('sha256').update(fingerprint.trim()).digest('hex').slice(0, 32),
      mode: 'offline',
      iat: now,
      jti: '00000000-0000-4000-8000-0000000000e2',
    })
  ).toString('base64url')
  return `${payload}.${sign(null, Buffer.from(payload), privateKey).toString('base64url')}`
}
