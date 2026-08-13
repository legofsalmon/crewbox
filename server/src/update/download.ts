import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assetFor,
  checkAsset,
  manifestNames,
  parseManifest,
  verifyManifest,
  type Manifest,
} from './verify.ts'

/**
 * Fetching a release and proving it is ours, without installing it.
 *
 * The order here is the point, and it is not the obvious one. The manifest
 * and its signature come first, and the big download only starts once the
 * signature has checked out — so a box on a compromised network spends a few
 * hundred bytes finding out it is being lied to, rather than two hundred
 * megabytes.
 *
 * Nothing is written where anything will find it until every check has
 * passed. The asset lands under a `.part` name and is renamed only at the
 * end, so a half-download, a killed process or a failed signature never
 * leaves something that looks like a build the box could run. Installing it
 * is a separate step in a separate commit; this one stops at "here is a file
 * we are sure about".
 */

/** Under the data dir, so it travels with the box and a wipe takes it too. */
export const UPDATES_DIR = 'updates'

/** A release larger than this is not one of ours. The .dmg is ~160 MB. */
export const MAX_ASSET_BYTES = 600 * 1024 * 1024

/** Manifest and signature are tiny; anything claiming otherwise is not them. */
export const MAX_SMALL_BYTES = 64 * 1024

export interface DownloadIo {
  fetch: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal }
  ) => Promise<{
    ok: boolean
    status: number
    text: () => Promise<string>
    arrayBuffer: () => Promise<ArrayBuffer>
  }>
  now: () => number
}

export const realDownloadIo: DownloadIo = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
}

export interface DownloadedBuild {
  /** Absolute path to the verified file. */
  path: string
  /** Asset name, as the release published it. */
  name: string
  version: string
  bytes: number
  sha256: string
  /** Which trusted key signed the manifest. Useful mid-rotation. */
  keyIndex: number
}

export type DownloadResult =
  | { ok: true; build: DownloadedBuild }
  | { ok: false; reason: string; stage: 'platform' | 'manifest' | 'signature' | 'asset' }

/** Where a release's files live: the tag page's download path. */
export function assetUrl(repoBase: string, version: string, name: string): string {
  return `${repoBase}/releases/download/${version}/${name}`
}

export const DIST_BASE = 'https://github.com/legofsalmon/crewbox-dist'

export interface DownloadOptions {
  version: string
  dataDir: string
  io?: DownloadIo
  base?: string
  platform?: NodeJS.Platform
  /** Overridable so a test can supply its own trusted keys. */
  keys?: readonly string[]
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
}

/**
 * Fetch, verify and keep one release build.
 *
 * Never throws: every failure is a `reason` a person can act on and a `stage`
 * saying how far it got, because "the signature did not check out" and "there
 * is no build for this platform" want very different responses from whoever
 * is reading.
 */
export async function downloadBuild(options: DownloadOptions): Promise<DownloadResult> {
  const io = options.io ?? realDownloadIo
  const base = options.base ?? DIST_BASE
  const { version, dataDir } = options

  const assetName = assetFor(version, options.platform ?? process.platform)
  if (!assetName) {
    return { ok: false, stage: 'platform', reason: 'there is no crewbox build for this platform' }
  }

  const names = manifestNames(version)

  // Small files first, and the signature checked before a single byte of the
  // real download. A box being lied to should find out cheaply.
  const manifestText = await getText(io, assetUrl(base, version, names.manifest))
  if (!manifestText.ok) {
    return {
      ok: false,
      stage: 'manifest',
      reason: `could not fetch the manifest: ${manifestText.reason}`,
    }
  }
  const signatureText = await getText(io, assetUrl(base, version, names.signature))
  if (!signatureText.ok) {
    return {
      ok: false,
      stage: 'signature',
      reason: `could not fetch the signature: ${signatureText.reason}`,
    }
  }

  const signed = verifyManifest(manifestText.body, signatureText.body, options.keys)
  if (!signed.ok) {
    return { ok: false, stage: 'signature', reason: signed.reason }
  }

  let manifest: Manifest
  try {
    manifest = parseManifest(manifestText.body)
  } catch (err) {
    // Reached only if a signed manifest is malformed, which would mean the
    // release process produced something nobody can check — worth saying
    // plainly rather than folding into a generic failure.
    return {
      ok: false,
      stage: 'manifest',
      reason: err instanceof Error ? err.message : 'the manifest could not be read',
    }
  }
  if (!manifest.has(assetName)) {
    return { ok: false, stage: 'asset', reason: `${assetName} is not in the signed manifest` }
  }

  const dir = join(dataDir, UPDATES_DIR)
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, assetName)
  const partPath = `${finalPath}.part`

  // Already here and still matching what was signed: nothing to fetch. This
  // is what makes a retry after a failed install cheap rather than another
  // two hundred megabytes over a venue's uplink.
  const existing = digestOfExisting(finalPath)
  if (existing && checkAsset(assetName, existing, manifest).ok) {
    options.log?.info(`update ${version}: already downloaded and verified`)
    return {
      ok: true,
      build: {
        path: finalPath,
        name: assetName,
        version,
        bytes: statSync(finalPath).size,
        sha256: existing,
        keyIndex: signed.keyIndex,
      },
    }
  }

  const asset = await getBytes(io, assetUrl(base, version, assetName), MAX_ASSET_BYTES)
  if (!asset.ok) {
    return { ok: false, stage: 'asset', reason: `could not fetch ${assetName}: ${asset.reason}` }
  }

  const digest = createHash('sha256').update(asset.body).digest('hex')
  const checked = checkAsset(assetName, digest, manifest)
  if (!checked.ok) {
    return { ok: false, stage: 'asset', reason: checked.reason }
  }

  // Written under `.part` and renamed only now. A file at the real name is a
  // file that passed every check — nothing downstream has to wonder.
  await writeFile(partPath, asset.body)
  renameSync(partPath, finalPath)
  options.log?.info(`update ${version}: downloaded and verified (${assetName})`)

  return {
    ok: true,
    build: {
      path: finalPath,
      name: assetName,
      version,
      bytes: asset.body.length,
      sha256: digest,
      keyIndex: signed.keyIndex,
    },
  }
}

/** Digest of a file already on disk, or null when there isn't one. */
function digestOfExisting(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** Remove a part-file left by a killed process. Never fails a caller. */
export function sweepPartials(dataDir: string): void {
  try {
    const dir = join(dataDir, UPDATES_DIR)
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.part')) rmSync(join(dir, name), { force: true })
    }
  } catch {
    // No updates directory yet, or no permission. Neither is worth a word.
  }
}

const TIMEOUT_MS = 60_000

async function getText(
  io: DownloadIo,
  url: string
): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  const got = await getBytes(io, url, MAX_SMALL_BYTES)
  if (!got.ok) return got
  return { ok: true, body: got.body.toString('utf8') }
}

async function getBytes(
  io: DownloadIo,
  url: string,
  limit: number
): Promise<{ ok: true; body: Buffer } | { ok: false; reason: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await io.fetch(url, {
      headers: { 'user-agent': 'crewbox', accept: 'application/octet-stream' },
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    const body = Buffer.from(await res.arrayBuffer())
    // Checked after the fact rather than by streaming, deliberately: these
    // are single files from one host and the ceiling is generous. If that
    // ever stops being true this is the line to change.
    if (body.length > limit) {
      return { ok: false, reason: `answer was ${body.length} bytes, over the ${limit} limit` }
    }
    return { ok: true, body }
  } catch (err) {
    const why = err instanceof Error && err.name === 'AbortError' ? 'timed out' : 'no answer'
    return { ok: false, reason: why }
  } finally {
    clearTimeout(timer)
  }
}
