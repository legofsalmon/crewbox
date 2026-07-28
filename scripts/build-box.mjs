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
  const csc = join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe'
  )
  const trayExe = join(outDir, 'crewbox-tray.exe')
  if (existsSync(csc)) {
    try {
      execFileSync(
        csc,
        [
          '/nologo',
          '/target:winexe',
          '/optimize+',
          `/out:${trayExe}`,
          '/reference:System.dll',
          '/reference:System.Drawing.dll',
          '/reference:System.Windows.Forms.dll',
          '/reference:System.Runtime.Serialization.dll',
          join(root, 'native', 'windows', 'CrewboxTray.cs'),
        ],
        { stdio: 'inherit' }
      )
      assets['helper/crewbox-tray.exe'] = trayExe
      hasTray = true
    } catch {
      // Never fail the box over its tray icon: a box with no tray is the
      // situation before this existed, a box that won't build is worse.
      console.warn('could not compile the tray helper — building without it')
    }
  } else {
    console.warn(`no csc.exe at ${csc} — building without the tray helper`)
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

// 4. Copy the node binary and inject the blob.
//
// The blob holds JavaScript and assets, not machine code, so it can be
// injected into a Node built for another architecture. That is how the Intel
// Mac box gets built on an Apple Silicon runner: point CREWBOX_BASE_NODE at
// an x64 Node (scripts/fetch-node.mjs) and set CREWBOX_TARGET_ARCH to match.
// The embedded livekit-server is native, so it has to be built for the same
// target — see CREWBOX_TARGET_ARCH in scripts/fetch-livekit.mjs.
const targetArch = process.env.CREWBOX_TARGET_ARCH ?? process.arch
const baseNode = process.env.CREWBOX_BASE_NODE ?? process.execPath
const exe = process.platform === 'win32' ? '.exe' : ''
const binName = `crewbox-${process.platform}-${targetArch}${exe}`
const binPath = join(outDir, binName)
copyFileSync(baseNode, binPath)
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
  `\nbuilt ${relative(root, binPath)} (${sizeMb} MB, v${version}+${commit}, ` +
    `${manifest.length} web assets, voice ${hasLivekit ? 'embedded' : 'NOT embedded'}` +
    `${process.platform === 'win32' ? `, tray ${hasTray ? 'embedded' : 'NOT embedded'}` : ''})`
)
if (!hasLivekit) {
  console.log('  run `node scripts/fetch-livekit.mjs` first to build a box with voice')
}
