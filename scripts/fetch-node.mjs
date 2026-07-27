// Fetch the official Node binary for another platform/arch, to use as the
// base of a cross-built box.
//
// Usage: node scripts/fetch-node.mjs <platform> <arch>   (e.g. darwin x64)
// Output: build/node/<platform>-<arch>/node — path printed on stdout
//
// A Node SEA is just the Node binary with a blob injected into it, and the
// blob itself is architecture-independent: it holds JavaScript and assets,
// not machine code. So an Intel Mac box can be built on an Apple Silicon
// runner by injecting into an Intel Node — which is how crewbox ships a
// darwin-x64 build without an Intel machine. GitHub is retiring its Intel
// runners, so depending on one was always borrowed time.
//
// The version is pinned to the running Node deliberately: the blob format is
// tied to the Node that generated it, so a mismatched base would produce a
// binary that fails at startup rather than at build time.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [platform, arch] = process.argv.slice(2)
if (!platform || !arch) {
  console.error('usage: node scripts/fetch-node.mjs <platform> <arch>')
  process.exit(1)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'build', 'node', `${platform}-${arch}`)
const target = join(outDir, 'node')

if (existsSync(target) && !process.env.NODE_REFETCH) {
  console.log(target)
  process.exit(0)
}

const version = process.version
const name = `node-${version}-${platform}-${arch}`
const base = `https://nodejs.org/dist/${version}`

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const archive = join(outDir, `${name}.tar.gz`)
const body = await fetch(`${base}/${name}.tar.gz`).then((r) => {
  if (!r.ok) throw new Error(`no Node build for ${platform}-${arch} at ${version} (${r.status})`)
  return r.arrayBuffer()
})
writeFileSync(archive, Buffer.from(body))

// nodejs.org publishes checksums for every artefact; this base binary ends up
// inside a release someone runs as their crew server, so verify it.
const sums = await fetch(`${base}/SHASUMS256.txt`).then((r) => {
  if (!r.ok) throw new Error(`could not fetch SHASUMS256.txt (${r.status})`)
  return r.text()
})
const expected = sums
  .split('\n')
  .find((line) => line.trim().endsWith(`${name}.tar.gz`))
  ?.split(/\s+/)[0]
if (!expected) throw new Error(`no checksum listed for ${name}.tar.gz`)
const actual = createHash('sha256').update(Buffer.from(body)).digest('hex')
if (actual !== expected) throw new Error(`checksum mismatch for ${name}.tar.gz`)

execFileSync('tar', ['-xzf', archive, '-C', outDir, `${name}/bin/node`], { stdio: 'inherit' })
renameSync(join(outDir, name, 'bin', 'node'), target)
rmSync(join(outDir, name), { recursive: true, force: true })
rmSync(archive, { force: true })
chmodSync(target, 0o755)

console.log(target)
