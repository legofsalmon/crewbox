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
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'build', 'livekit')
const exe = process.platform === 'win32' ? '.exe' : ''
const target = join(outDir, `livekit-server${exe}`)

if (existsSync(target) && !process.env.LIVEKIT_REFETCH) {
  console.log(`livekit-server already present at ${target}`)
  process.exit(0)
}

/**
 * Platforms LiveKit ships no release binary for. macOS is distributed through
 * Homebrew only — there is no darwin asset on any release — so a macOS box
 * cannot carry an SFU however the build is arranged.
 *
 * This is deliberately an allowlist of *known* gaps rather than a general
 * "asset missing, carry on". A missing asset on Linux or Windows still fails
 * the build loudly: that would mean upstream renamed something, and a
 * silently voiceless box is worse than a red release. The macOS box builds
 * fine without it and reports voice as off in Admin → This box.
 */
const NO_UPSTREAM_BUILD = new Set(['darwin'])
if (NO_UPSTREAM_BUILD.has(process.platform)) {
  console.log(
    `livekit publishes no ${process.platform} binary (Homebrew only) — ` +
      'building a box without the voice server.'
  )
  process.exit(0)
}

/** LiveKit's release asset naming, e.g. livekit_1.9.0_linux_amd64.tar.gz */
const platform = { linux: 'linux', win32: 'windows' }[process.platform]
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
if (!platform || !arch) {
  console.error(`no livekit-server build for ${process.platform}/${process.arch}`)
  process.exit(1)
}

const api = 'https://api.github.com/repos/livekit/livekit/releases/latest'
const headers = { 'user-agent': 'crewbox-build' }
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`

const release = await fetch(api, { headers }).then((r) => {
  if (!r.ok) throw new Error(`GitHub API ${r.status} fetching the latest livekit release`)
  return r.json()
})

const wanted = `${platform}_${arch}`
const asset = release.assets.find((a) => a.name.includes(wanted) && /\.(tar\.gz|zip)$/.test(a.name))
if (!asset) {
  console.error(
    `no ${wanted} asset in livekit ${release.tag_name}. Assets:\n  ` +
      release.assets.map((a) => a.name).join('\n  ')
  )
  process.exit(1)
}

console.log(`fetching ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB)`)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const archive = join(outDir, asset.name)
const body = await fetch(asset.browser_download_url, { headers }).then((r) => {
  if (!r.ok) throw new Error(`download failed: ${r.status}`)
  return r.arrayBuffer()
})
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
