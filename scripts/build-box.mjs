// Build the single-file "box" binary: the whole crewbox server plus the
// built web app in one executable for the current platform. Download,
// double-click, scan the QR — no Node, no npm, no git on the box.
//
// Usage: npm run build -w web && node scripts/build-box.mjs
// Output: build/box/crewbox-<platform>-<arch>[.exe]
import { execFileSync, execSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// fileURLToPath, not URL.pathname — the latter yields /C:/... on Windows,
// which every fs call then fails to resolve.
const root = fileURLToPath(new URL('..', import.meta.url))
const distDir = join(root, 'web', 'dist')
const outDir = join(root, 'build', 'box')

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('web/dist not found — run `npm run build -w web` first')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const version = JSON.parse(readFileSync(join(root, 'server', 'package.json'), 'utf8')).version
let commit = 'unknown'
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim()
} catch {
  /* release tarballs have no .git */
}

// 1. Bundle the TS server (workspace deps included) into one CJS file.
await build({
  entryPoints: [join(root, 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(outDir, 'bundle.cjs'),
  // Optional ws accelerators — not installed, never required at runtime.
  external: ['bufferutil', 'utf-8-validate'],
  define: {
    'process.env.DEPLOY_VERSION': JSON.stringify(version),
    'process.env.DEPLOY_COMMIT': JSON.stringify(commit),
  },
  logLevel: 'warning',
})

// 2. Embed the web bundle as SEA assets plus a manifest for extraction.
const assets = {}
const manifest = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else {
      const rel = relative(distDir, path).split('\\').join('/')
      manifest.push(rel)
      assets[`dist/${rel}`] = path
    }
  }
}
walk(distDir)
const manifestPath = join(outDir, 'dist-manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest))
assets['dist-manifest.json'] = manifestPath

// 3. Generate the SEA blob.
const seaConfigPath = join(outDir, 'sea-config.json')
writeFileSync(
  seaConfigPath,
  JSON.stringify({
    main: join(outDir, 'bundle.cjs'),
    output: join(outDir, 'sea.blob'),
    disableExperimentalSEAWarning: true,
    assets,
  })
)
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' })

// 4. Copy the node binary and inject the blob.
const exe = process.platform === 'win32' ? '.exe' : ''
const binName = `crewbox-${process.platform}-${process.arch}${exe}`
const binPath = join(outDir, binName)
copyFileSync(process.execPath, binPath)
if (process.platform === 'darwin') {
  execSync(`codesign --remove-signature "${binPath}"`)
}
const postjectArgs = [
  'postject',
  binPath,
  'NODE_SEA_BLOB',
  join(outDir, 'sea.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA')
execFileSync('npx', postjectArgs, { stdio: 'inherit', shell: process.platform === 'win32' })
if (process.platform === 'darwin') {
  execSync(`codesign --sign - "${binPath}"`)
} else if (process.platform !== 'win32') {
  chmodSync(binPath, 0o755)
}

const sizeMb = (statSync(binPath).size / 1024 / 1024).toFixed(0)
console.log(
  `\nbuilt ${relative(root, binPath)} (${sizeMb} MB, v${version}+${commit}, ${manifest.length} web assets)`
)
