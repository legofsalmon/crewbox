// Builds the single-file "festival box" executable for the CURRENT platform:
// the relay server bundled with esbuild, the built web app embedded as SEA
// assets, injected into a copy of the Node runtime.
//
//   npm run build        # produce dist/ first
//   npm run build:sea    # produce build/sea/livepatch-<os>-<arch>[.exe]
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, mkdirSync, rmSync, copyFileSync, chmodSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { inject } from 'postject'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, 'dist')
const outDir = join(root, 'build', 'sea')

try {
  statSync(join(distDir, 'index.html'))
} catch {
  console.error('dist/index.html not found — run `npm run build` first.')
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// 1. Bundle the server (and its deps) into one CJS file.
const bundlePath = join(outDir, 'bundle.cjs')
await build({
  entryPoints: [join(root, 'server', 'index.cjs')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: bundlePath,
  // Optional native accelerators of `ws` — absent at runtime, ws falls back
  // to its JS implementations.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
})

// 2. Collect the built app as embedded assets, keyed dist/<relative-path>.
const assets = {}
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else assets[`dist/${relative(distDir, full).split('\\').join('/')}`] = full
  }
}
walk(distDir)

// 3. Generate the SEA blob.
const seaConfigPath = join(outDir, 'sea-config.json')
const blobPath = join(outDir, 'sea-prep.blob')
await writeFile(
  seaConfigPath,
  JSON.stringify({
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    assets,
  })
)
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' })

// 4. Copy the Node runtime and inject the blob.
const osName = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]
const exeName = `livepatch-${osName}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`
const exePath = join(outDir, exeName)
copyFileSync(process.execPath, exePath)

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', exePath])
}

await inject(exePath, 'NODE_SEA_BLOB', await readFile(blobPath), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
})

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', exePath])
}
if (process.platform !== 'win32') chmodSync(exePath, 0o755)

const sizeMb = (statSync(exePath).size / (1024 * 1024)).toFixed(0)
console.log(
  `\nBuilt ${relative(root, exePath)} (${sizeMb} MB, ${Object.keys(assets).length} embedded app files)`
)
