import { createHash, generateKeyPairSync, sign as signWith } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DIST_BASE,
  MAX_SMALL_BYTES,
  UPDATES_DIR,
  assetUrl,
  downloadBuild,
  sweepPartials,
  type DownloadIo,
} from '../src/update/download.ts'

/**
 * Fetching a build and refusing to keep one we cannot prove is ours.
 *
 * The two properties worth defending: the signature is checked **before** the
 * large download starts, so a box on a hostile network finds out cheaply; and
 * nothing ever reaches the real filename unless every check passed, so no
 * later step has to wonder whether the file it found is trustworthy.
 */

const VERSION = 'v0.18.0'
const LINUX = `crewbox-linux-x64-${VERSION}`
const BODY = Buffer.from('a plausible crewbox binary')

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string
const KEYS = [PEM]

const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex')

type Answer = Awaited<ReturnType<DownloadIo['fetch']>>

/** A release server. `overrides` bends one file to model a specific attack. */
function fakeIo(
  overrides: { manifest?: string; signature?: string; asset?: Buffer; missing?: string[] } = {},
  fetched: string[] = []
): DownloadIo {
  const manifest = overrides.manifest ?? `${digest(BODY)}  ${LINUX}\n`
  const signature =
    overrides.signature ??
    signWith(null, Buffer.from(manifest, 'utf8'), privateKey).toString('base64')
  const asset = overrides.asset ?? BODY

  return {
    fetch: (url) => {
      fetched.push(url)
      const name = url.split('/').pop() ?? ''
      if (overrides.missing?.includes(name)) {
        const missing: Answer = {
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }
        return Promise.resolve(missing)
      }
      const body = name.endsWith('.sig')
        ? Buffer.from(signature)
        : name.startsWith('SHA256SUMS')
          ? Buffer.from(manifest)
          : asset
      const answer: Answer = {
        ok: true,
        status: 200,
        text: () => Promise.resolve(body.toString('utf8')),
        // Copied out of the Buffer's pool rather than sliced from it: a
        // Buffer's backing store may be a SharedArrayBuffer, which is not
        // what a fetch() body ever hands back.
        arrayBuffer: () => Promise.resolve(Uint8Array.from(body).buffer as ArrayBuffer),
      }
      return Promise.resolve(answer)
    },
    now: () => 1_000,
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-dl-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const run = (io: DownloadIo, platform: NodeJS.Platform = 'linux', keys = KEYS) =>
  downloadBuild({
    version: VERSION,
    dataDir: dir,
    io,
    keys,
    platform,
    base: 'https://example.test',
  })

describe('the happy path', () => {
  it('fetches, verifies and keeps the build', async () => {
    const result = await run(fakeIo())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.build.name).toBe(LINUX)
    expect(result.build.sha256).toBe(digest(BODY))
    expect(result.build.keyIndex).toBe(0)
    expect(existsSync(result.build.path)).toBe(true)
  })

  it('checks the signature before downloading the large file', async () => {
    // The property that keeps a box on a hostile network from spending two
    // hundred megabytes learning it is being lied to.
    const fetched: string[] = []
    await run(fakeIo({}, fetched))
    expect(fetched[0]).toContain('SHA256SUMS-v0.18.0')
    expect(fetched[1]).toContain('SHA256SUMS-v0.18.0.sig')
    expect(fetched[2]).toContain(LINUX)
  })

  it('does not re-download a build it already has and can still verify', async () => {
    await run(fakeIo())
    const fetched: string[] = []
    const again = await run(fakeIo({}, fetched))
    expect(again.ok).toBe(true)
    // Manifest and signature again — cheap, and they are what prove the file
    // on disk is still the right one — but not the asset.
    expect(fetched.some((u) => u.endsWith(LINUX))).toBe(false)
  })

  it('picks the right asset per platform', async () => {
    const fetched: string[] = []
    await downloadBuild({
      version: VERSION,
      dataDir: dir,
      io: fakeIo({ manifest: `${digest(BODY)}  Crewbox-${VERSION}.dmg\n` }, fetched),
      keys: KEYS,
      platform: 'darwin',
      base: 'https://example.test',
    })
    expect(fetched.some((u) => u.endsWith(`Crewbox-${VERSION}.dmg`))).toBe(true)
  })
})

describe('refusing what it cannot prove', () => {
  it('rejects a manifest signed by a key it does not trust', async () => {
    const attacker = generateKeyPairSync('ed25519')
    const manifest = `${digest(BODY)}  ${LINUX}\n`
    const io = fakeIo({
      manifest,
      signature: signWith(null, Buffer.from(manifest), attacker.privateKey).toString('base64'),
    })
    const result = await run(io)
    expect(result).toMatchObject({ ok: false, stage: 'signature' })
  })

  it('rejects an asset whose bytes differ from the signed manifest', async () => {
    // The substitution: a correctly signed manifest, but the file served is
    // not the file it describes.
    const result = await run(fakeIo({ asset: Buffer.from('something else entirely') }))
    expect(result).toMatchObject({ ok: false, stage: 'asset' })
    if (result.ok) return
    expect(result.reason).toContain('does not match the digest')
  })

  it('rejects an asset the signed manifest never mentioned', async () => {
    const result = await run(fakeIo({ manifest: `${digest(BODY)}  some-other-file\n` }))
    expect(result).toMatchObject({ ok: false, stage: 'asset' })
  })

  it('keeps nothing on disk when a check fails', async () => {
    // The property everything downstream leans on: a file at the real name
    // is a file that passed. No half-download, no rejected build, no .part.
    await run(fakeIo({ asset: Buffer.from('wrong') }))
    const updates = join(dir, UPDATES_DIR)
    const left = existsSync(updates) ? readdirSync(updates) : []
    expect(left).toEqual([])
  })

  it('refuses everything when the build trusts no keys', async () => {
    const result = await run(fakeIo(), 'linux', [])
    expect(result).toMatchObject({ ok: false, stage: 'signature' })
    if (result.ok) return
    expect(result.reason).toContain('trusts no release keys')
  })

  it('says so plainly when there is no build for this platform', async () => {
    const result = await run(fakeIo(), 'freebsd')
    expect(result).toMatchObject({ ok: false, stage: 'platform' })
  })

  it('reports a missing manifest as a manifest problem, not a mystery', async () => {
    const result = await run(fakeIo({ missing: [`SHA256SUMS-${VERSION}`] }))
    expect(result).toMatchObject({ ok: false, stage: 'manifest' })
    if (result.ok) return
    expect(result.reason).toContain('HTTP 404')
  })

  it('refuses a manifest far larger than one could be', async () => {
    const result = await run(fakeIo({ manifest: 'x'.repeat(MAX_SMALL_BYTES + 1) }))
    expect(result.ok).toBe(false)
  })
})

describe('when the disk will not take it', () => {
  it('reports it rather than throwing out of a function that never throws', async () => {
    // `downloadBuild` is documented never to throw, and its caller's catch
    // says so in as many words — so an ENOSPC escaping here was reported to
    // an admin as an internal bug rather than as a full disk. A build is
    // exactly the size of thing a box runs out of room for.
    const updates = join(dir, 'updates')
    mkdirSync(updates, { recursive: true })
    // A directory where the `.part` file wants to be: the write fails with
    // EISDIR, which is a real errno from the same line as ENOSPC.
    mkdirSync(join(updates, `${LINUX}.part`), { recursive: true })
    const result = await run(fakeIo())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.stage).toBe('asset')
    expect(result.reason).toContain(`could not save ${LINUX}`)
  })
})

describe('tidying up', () => {
  it('sweeps a part-file left by a killed process', async () => {
    const updates = join(dir, UPDATES_DIR)
    mkdirSync(updates, { recursive: true })
    writeFileSync(join(updates, `${LINUX}.part`), 'half a download')
    writeFileSync(join(updates, LINUX), 'a real one')
    sweepPartials(dir)
    expect(readdirSync(updates)).toEqual([LINUX])
  })

  it('does not mind a box that has never downloaded anything', () => {
    expect(() => sweepPartials(dir)).not.toThrow()
  })
})

describe('urls', () => {
  it('points at the public mirror, where no token is needed', () => {
    expect(DIST_BASE).toContain('crewbox-dist')
    expect(assetUrl(DIST_BASE, VERSION, LINUX)).toBe(
      `https://github.com/legofsalmon/crewbox-dist/releases/download/${VERSION}/${LINUX}`
    )
  })
})
