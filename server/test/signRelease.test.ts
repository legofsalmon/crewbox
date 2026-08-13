import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseManifest, verifyManifest } from '../src/update/verify.ts'

/**
 * The signing script, checked against the verifier that has to accept its
 * output.
 *
 * These two are written to the same format from opposite directions — one in
 * a build script, one in the box — and a release where they disagree is a
 * release every box refuses. That makes this the most valuable test in the
 * updater: it is the only place the two halves meet before a real release
 * does it for us.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/sign-release.mjs', import.meta.url))
const VERSION = 'v0.18.0'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string

let dir: string
let assets: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-sign-'))
  assets = join(dir, 'assets')
  mkdirSync(assets)
  writeFileSync(join(assets, `crewbox-linux-x64-${VERSION}`), 'a linux box')
  writeFileSync(join(assets, `Crewbox-${VERSION}.dmg`), 'a disk image')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const sign = (key: string | undefined) =>
  execFileSync('node', [SCRIPT, assets, VERSION], {
    encoding: 'utf8',
    env: { ...process.env, ...(key === undefined ? {} : { RELEASE_SIGNING_KEY: key }) },
  })

const read = () => ({
  manifest: readFileSync(join(assets, `SHA256SUMS-${VERSION}`), 'utf8'),
  signature: readFileSync(join(assets, `SHA256SUMS-${VERSION}.sig`), 'utf8'),
})

describe('signing a release', () => {
  it('produces a manifest the box accepts', async () => {
    sign(PRIVATE_PEM)
    const { manifest, signature } = read()
    expect(verifyManifest(manifest, signature, [PUBLIC_PEM])).toEqual({ ok: true, keyIndex: 0 })
    expect(parseManifest(manifest).size).toBe(2)
  })

  it('writes what sha256sum writes, so a human can check it without us', async () => {
    sign(PRIVATE_PEM)
    const { manifest } = read()
    // Two spaces, and a trailing newline: `sha256sum -c` depends on both.
    expect(manifest).toMatch(/^[0-9a-f]{64} {2}\S/m)
    expect(manifest.endsWith('\n')).toBe(true)
  })

  it('sorts the lines, so the same inputs give the same bytes', async () => {
    // A signature over a file whose line order follows the filesystem is a
    // signature nobody can reproduce by hand.
    sign(PRIVATE_PEM)
    const names = read()
      .manifest.trim()
      .split('\n')
      .map((l) => l.split(/\s+/)[1])
    expect(names).toEqual([...names].sort())
  })

  it('does not sign its own output', async () => {
    // Signing the manifest into the manifest is not possible, and a stale
    // entry for it would be worse than none.
    sign(PRIVATE_PEM)
    expect(parseManifest(read().manifest).has(`SHA256SUMS-${VERSION}`)).toBe(false)
  })

  it('is stable across runs, given the same assets', async () => {
    sign(PRIVATE_PEM)
    const first = read()
    sign(PRIVATE_PEM)
    expect(read().manifest).toBe(first.manifest)
  })
})

describe('refusing to publish something unverifiable', () => {
  it('fails the release when the key is missing', () => {
    // A release that quietly shipped unsigned would be worse than one that
    // did not ship: every box would refuse it, four steps from the cause.
    expect(() => sign(undefined)).toThrow()
  })

  it('fails when the key is set but empty', () => {
    expect(() => sign('   ')).toThrow()
  })

  it('fails on a key that is not a key, rather than writing a bad signature', () => {
    expect(() => sign('-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----')).toThrow()
  })

  it('fails when there is nothing to sign', () => {
    rmSync(assets, { recursive: true, force: true })
    mkdirSync(assets)
    expect(() => sign(PRIVATE_PEM)).toThrow()
  })
})
