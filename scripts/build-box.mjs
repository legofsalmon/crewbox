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
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildTray } from './build-tray.mjs'

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

// 2b. Embed the LiveKit SFU so voice needs no second install. Optional: a
// build without it is still a complete box, it just can't run voice itself
// (see server/src/livekit.ts). Run scripts/fetch-livekit.mjs to get it.
const livekitExe = process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server'
const livekitPath = join(root, 'build', 'livekit', livekitExe)
const hasLivekit = existsSync(livekitPath)
if (hasLivekit) assets[`livekit/${livekitExe}`] = livekitPath

// 2c. The Windows tray icon, compiled here and carried inside the binary.
//
// Started from Explorer the box shows a console window someone closes, or
// none at all, leaving a server running with nothing to click. The tray
// helper is the fix (native/windows/CrewboxTray.cs); embedding it keeps the
// promise that the download is one file.
//
// csc.exe from the .NET Framework, which is on every Windows 10/11 machine —
// no SDK to install and about 15 KB of output. Optional in exactly the way
// LiveKit is: a box built without it still works, it just has no tray.
let hasTray = false
if (process.platform === 'win32') {
  try {
    // build/tray, not build/box. The release uploads build/box/crewbox-* and
    // that glob swept the helper up, so v0.7.2 shipped a stray 11 KB
    // crewbox-tray.exe on the download page beside the box — confusing, and
    // pointless, since it is already inside the .exe.
    const trayExe = buildTray(join(root, 'build', 'tray', 'crewbox-tray.exe'))
    if (trayExe) {
      assets['helper/crewbox-tray.exe'] = trayExe
      hasTray = true
    } else {
      console.warn('no csc.exe found — building without the tray helper')
    }
  } catch {
    // Never fail the box over its tray icon: a box with no tray is the
    // situation before this existed, a box that won't build is worse. CI
    // compiles it on every pull request, so a real breakage is caught there
    // rather than being quietly swallowed here.
    console.warn('could not compile the tray helper — building without it')
  }
}

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

/**
 * The fuse Node looks for to decide whether it is a single executable.
 *
 * postject flips the byte after the colon from 0 to 1 as it injects, so the
 * fuse is also the proof that it did: a binary carrying `:0` is plain Node
 * wearing crewbox's name.
 */
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

/** Throw unless this file really is a single executable now. */
function assertBlobInjected(path) {
  const bytes = readFileSync(path)
  const at = bytes.indexOf(`${SEA_FUSE}:`)
  if (at === -1) throw new Error(`${path} has no SEA fuse — is the base Node the right build?`)
  const flag = String.fromCharCode(bytes[at + SEA_FUSE.length + 1])
  if (flag !== '1') throw new Error(`${path} has no blob injected — postject did not take`)
}

// 4. Copy the node binary and inject the blob.
//
// The blob holds JavaScript and assets, not machine code, so it can be
// injected into a Node built for another architecture. That is how the Intel
// Mac box gets built on an Apple Silicon runner: point CREWBOX_BASE_NODE at
// an x64 Node (scripts/fetch-node.mjs) and set CREWBOX_TARGET_ARCH to match.
// The embedded livekit-server is native, so it has to be built for the same
// target — see CREWBOX_TARGET_ARCH in scripts/fetch-livekit.mjs.
const targetArch = process.env.CREWBOX_TARGET_ARCH ?? process.arch
// An empty CREWBOX_BASE_NODE is a failure, not a default. `??` keeps the
// empty string, which is what the release's Intel leg produces when
// fetch-node fails inside a command substitution: bash masks that in
// `VAR="$(...)" cmd`, so the build would carry on with nothing to inject
// into. Say so here rather than several confusing steps later.
if (process.env.CREWBOX_BASE_NODE !== undefined && !process.env.CREWBOX_BASE_NODE.trim()) {
  console.error('CREWBOX_BASE_NODE is set but empty — the base Node was not fetched')
  process.exit(1)
}
const baseNode = process.env.CREWBOX_BASE_NODE ?? process.execPath
const exe = process.platform === 'win32' ? '.exe' : ''
const binName = `crewbox-${process.platform}-${targetArch}${exe}`
const binPath = join(outDir, binName)

/**
 * Built under another name and moved into place at the very end.
 *
 * The release uploads `build/box/crewbox-*`, and the Intel leg is
 * `continue-on-error` on purpose — one architecture is not worth failing a
 * release over. But a step that died *between* the copy and the injection
 * left `crewbox-darwin-x64` sitting there as an unmodified copy of Node,
 * and the glob shipped it: someone downloaded the Intel box, ran it, and
 * got a Node REPL. A skipped build has to be a missing asset, which is
 * visible, and never a broken one, which is not.
 */
const partPath = `${binPath}.partial`
rmSync(binPath, { force: true })
rmSync(partPath, { force: true })
try {
  copyFileSync(baseNode, partPath)
  if (process.platform === 'darwin') {
    execSync(`codesign --remove-signature "${partPath}"`)
  }
  const postjectArgs = [
    'postject',
    partPath,
    'NODE_SEA_BLOB',
    join(outDir, 'sea.blob'),
    '--sentinel-fuse',
    SEA_FUSE,
  ]
  if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA')
  execFileSync('npx', postjectArgs, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (process.platform === 'darwin') {
    execSync(`codesign --sign - "${partPath}"`)
  } else if (process.platform !== 'win32') {
    chmodSync(partPath, 0o755)
  }
  assertBlobInjected(partPath)
  renameSync(partPath, binPath)
} finally {
  rmSync(partPath, { force: true })
}

const sizeMb = (statSync(binPath).size / 1024 / 1024).toFixed(0)
console.log(
  `\nbuilt ${relative(root, binPath)} (${sizeMb} MB, v${version}+${commit}, ` +
    `${manifest.length} web assets, voice ${hasLivekit ? 'embedded' : 'NOT embedded'}` +
    `${process.platform === 'win32' ? `, tray ${hasTray ? 'embedded' : 'NOT embedded'}` : ''})`
)
if (!hasLivekit) {
  console.log('  run `node scripts/fetch-livekit.mjs` first to build a box with voice')
}
