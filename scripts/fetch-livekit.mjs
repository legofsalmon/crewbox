// Fetch the livekit-server binary for this platform so the box build can
// embed it. Voice is only a real feature if it needs no second install, and
// that means the SFU ships inside the box.
//
// Usage: node scripts/fetch-livekit.mjs
// Output: build/livekit/livekit-server[.exe]
//
// Needs internet, so it runs on the build machine and in CI, never on site.
// The box build treats a missing binary as "this build has no voice" rather
// than an error, so a offline `npm run build:box` still produces a box.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetFor, digestFor, findChecksumAsset } from './livekit-release.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'build', 'livekit')
const exe = process.platform === 'win32' ? '.exe' : ''
const target = join(outDir, `livekit-server${exe}`)

if (existsSync(target) && !process.env.LIVEKIT_REFETCH) {
  console.log(`livekit-server already present at ${target}`)
  process.exit(0)
}

/**
 * Platforms LiveKit publishes no release binary for. macOS is the only one:
 * every release carries linux and windows archives and nothing for darwin,
 * because upstream distributes macOS through Homebrew.
 *
 * Homebrew's formula compiles it, and so do we — livekit-server is pure Go
 * with no cgo, so `go install` produces the same program the tarballs carry.
 * That keeps the promise that matters on every platform: voice is inside the
 * box, with nothing for an admin to install.
 *
 * This is an allowlist of *known* gaps, not a general "asset missing, carry
 * on". A missing asset on Linux or Windows still fails the build loudly —
 * that would mean upstream renamed something, and a silently voiceless box is
 * worse than a red release.
 */
const BUILD_FROM_SOURCE = new Set(['darwin'])
const fromSource = BUILD_FROM_SOURCE.has(process.platform)

/** LiveKit's release asset naming, e.g. livekit_1.9.0_linux_amd64.tar.gz */
const platform = { linux: 'linux', win32: 'windows' }[process.platform]
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
if (!fromSource && (!platform || !arch)) {
  console.error(`no livekit-server build for ${process.platform}/${process.arch}`)
  process.exit(1)
}

/**
 * The SFU version this build embeds.
 *
 * `LIVEKIT_VERSION` names a tag; unset, this resolves whatever upstream
 * calls latest. Every platform job used to resolve `latest` on its own, at
 * whatever minute it happened to start — so a release cut across an upstream
 * release ships a Linux box and a macOS box carrying different SFUs, and
 * nothing in the release says so. The workflow resolves it once now and
 * passes the tag down; this variable is how.
 */
const wantedVersion = process.env.LIVEKIT_VERSION?.trim()
const repo = 'https://api.github.com/repos/livekit/livekit/releases'
const api = wantedVersion ? `${repo}/tags/${wantedVersion}` : `${repo}/latest`
const headers = { 'user-agent': 'crewbox-build' }
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`

const release = await fetch(api, { headers }).then((r) => {
  if (!r.ok) {
    throw new Error(`GitHub API ${r.status} fetching livekit ${wantedVersion ?? 'latest'} — ${api}`)
  }
  return r.json()
})

if (fromSource) {
  // Pin to the same tag the other platforms download, so one release never
  // ships three different SFU versions.
  const version = release.tag_name

  // CREWBOX_TARGET_ARCH cross-builds the Intel Mac SFU on an Apple Silicon
  // runner (see scripts/fetch-node.mjs), because GitHub is retiring its Intel
  // runners and one became unschedulable mid-release.
  //
  // This branch only ever runs on macOS, which is what makes it possible:
  // livekit's darwin CPU stats are cgo-only, and clang on a Mac targets both
  // architectures. The same build from Linux fails on undefined cpu.Get,
  // because a darwin target there forces CGO_ENABLED=0.
  const targetArch = process.env.CREWBOX_TARGET_ARCH ?? process.arch
  const goarch = { x64: 'amd64', arm64: 'arm64' }[targetArch]
  if (!goarch) {
    console.error(`no GOARCH for ${targetArch}`)
    process.exit(1)
  }

  const goVersion = (() => {
    try {
      return execFileSync('go', ['version'], { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  })()

  if (!goVersion) {
    // On CI this must be fatal: a release binary that quietly lost voice is
    // the exact failure this script exists to prevent. A developer building
    // locally gets a working box without voice instead of a hard stop.
    const message = 'go toolchain not found, needed to build livekit-server for macOS'
    if (process.env.CI) {
      console.error(`${message}. Add actions/setup-go to this job.`)
      process.exit(1)
    }
    console.log(`${message} — building a box without the voice server.`)
    process.exit(0)
  }

  console.log(`building livekit-server ${version} for darwin/${goarch} with ${goVersion}`)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  // From a checkout, not `go install pkg@version`.
  //
  // livekit's go.mod carries `replace` directives from v1.13 — its own forks
  // of three pion modules — and Go refuses to `install` a module whose go.mod
  // would be read differently as a dependency than as the main module. That
  // is not a workaround to route around: those replaces are how the SFU is
  // built, so the build has to happen inside the module, where they apply.
  // v1.11 and v1.12 had none, which is why this worked until it didn't.
  //
  // What this costs, said plainly: `go install` resolved the module through
  // the checksum database, and a clone does not. Every *dependency* is still
  // verified against sum.golang.org, the forks included; livekit's own source
  // now arrives over TLS at a tag, and the commit it resolved to is printed
  // below so a release can be traced back to one.
  const src = join(root, 'build', 'livekit-src')
  rmSync(src, { recursive: true, force: true })
  execFileSync(
    'git',
    ['clone', '--depth', '1', '--branch', version, 'https://github.com/livekit/livekit.git', src],
    { stdio: 'inherit' }
  )
  const commit = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  console.log(`livekit ${version} is ${commit}`)

  execFileSync('go', ['build', '-o', target, './cmd/server'], {
    cwd: src,
    stdio: 'inherit',
    env: {
      ...process.env,
      GOARCH: goarch,
      GOOS: 'darwin',
      // Explicit because it is load-bearing, not incidental: livekit's darwin
      // CPU stats are cgo-only, and a build with cgo off fails to compile.
      CGO_ENABLED: '1',
    },
  })

  if (!existsSync(target)) {
    console.error(`go build produced no binary at ${target}`)
    process.exit(1)
  }

  console.log(`livekit-server ${version} ready at ${target}`)
  process.exit(0)
}

const asset = assetFor(release.assets, platform, arch)
if (!asset) {
  console.error(
    `no ${platform}_${arch} asset in livekit ${release.tag_name}. Assets:\n  ` +
      release.assets.map((a) => a.name).join('\n  ')
  )
  process.exit(1)
}

// What this build expects the archive to hash to, before it is written to
// disk. The Node base binary this box is built on is verified against
// nodejs.org's SHASUMS256.txt for exactly this reason (see fetch-node.mjs);
// the SFU that ships beside it inside the same binary was not verified at
// all. A build that cannot find a checksum stops here rather than embedding
// something unchecked — if upstream stops publishing one, that is a decision
// to take deliberately and not a line to notice afterwards.
// Two independent places a digest can come from: the release's own checksums
// file, and the per-asset `digest` GitHub itself records. Either will do; if
// neither is there, this stops rather than embedding something unchecked.
const checksums = findChecksumAsset(release.assets)
let expected = null
let source = ''
if (checksums) {
  expected = digestFor(
    await fetch(checksums.browser_download_url, { headers }).then((r) => {
      if (!r.ok) throw new Error(`could not fetch ${checksums.name} (${r.status})`)
      return r.text()
    }),
    asset.name
  )
  source = checksums.name
}
if (!expected && typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
  expected = asset.digest.slice('sha256:'.length).toLowerCase()
  source = "GitHub's own asset digest"
}
if (!expected) {
  console.error(
    `nothing to verify ${asset.name} against: livekit ${release.tag_name} publishes no ` +
      `checksums file and GitHub reports no digest for the asset. Assets:\n  ` +
      release.assets.map((a) => a.name).join('\n  ')
  )
  process.exit(1)
}

console.log(
  `fetching ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB), verified against ${source}`
)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const archive = join(outDir, asset.name)
const body = await fetch(asset.browser_download_url, { headers }).then((r) => {
  if (!r.ok) throw new Error(`download failed: ${r.status}`)
  return r.arrayBuffer()
})
const actual = createHash('sha256').update(Buffer.from(body)).digest('hex')
if (actual !== expected) {
  console.error(`checksum mismatch for ${asset.name} (against ${source})`)
  console.error(`  expected ${expected}`)
  console.error(`  got      ${actual}`)
  process.exit(1)
}
writeFileSync(archive, Buffer.from(body))

if (asset.name.endsWith('.zip')) {
  // PowerShell's Expand-Archive is the one unzip every Windows runner has.
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path "${archive}" -DestinationPath "${outDir}" -Force`,
    ],
    { stdio: 'inherit' }
  )
} else {
  execFileSync('tar', ['-xzf', archive, '-C', outDir], { stdio: 'inherit' })
}
rmSync(archive, { force: true })

// The archive layout has moved between releases; find the binary wherever it landed.
const found = readdirSync(outDir, { recursive: true, withFileTypes: true }).find(
  (entry) => entry.isFile() && /^livekit-server(\.exe)?$/.test(entry.name)
)
if (!found) {
  console.error(`no livekit-server binary inside ${asset.name}`)
  process.exit(1)
}
const extracted = join(found.parentPath ?? found.path ?? outDir, found.name)
if (extracted !== target) renameSync(extracted, target)

console.log(`livekit-server ${release.tag_name} ready at ${target}`)
