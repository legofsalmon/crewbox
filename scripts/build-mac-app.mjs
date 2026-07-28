// Build Crewbox.app and a .dmg from the two darwin box binaries.
//
// Usage: node scripts/build-mac-app.mjs <x64-binary> <arm64-binary>
// Output: build/mac/Crewbox.app, build/mac/Crewbox-<version>.dmg
//
// macOS only — needs lipo, iconutil, hdiutil and codesign.
//
// Why a .dmg at all, when the bare binary works: macOS quarantines anything
// downloaded, and refuses to open an unsigned quarantined binary with a
// dialog offering no way forward. The one-line installer works around that
// by stripping the attribute, but that means a Terminal paste. A signed and
// notarised .dmg is the only route to "download, double-click, done" — and
// it lets one file serve both Intel and Apple Silicon, so nobody has to know
// which Mac they own.
//
// Signing is optional. Without credentials this still produces a working
// (unsigned) .dmg, so the packaging path is exercised on every release and
// only the trust step waits on an Apple Developer account. See
// docs/MACOS_SIGNING.md.
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()

if (process.platform !== 'darwin') {
  console.error('build-mac-app.mjs only runs on macOS')
  process.exit(1)
}

const inputs = process.argv.slice(2).filter(Boolean)
if (inputs.length === 0) {
  console.error('usage: node scripts/build-mac-app.mjs <binary> [<binary>…]')
  process.exit(1)
}
for (const input of inputs) {
  if (!existsSync(input)) {
    console.error(`missing input binary: ${input}`)
    process.exit(1)
  }
}

const { version } = JSON.parse(
  execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], {
    cwd: root,
    encoding: 'utf8',
  })
)

const outDir = join(root, 'build', 'mac')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const app = join(outDir, 'Crewbox.app')
const macosDir = join(app, 'Contents', 'MacOS')
const resourcesDir = join(app, 'Contents', 'Resources')
mkdirSync(macosDir, { recursive: true })
mkdirSync(resourcesDir, { recursive: true })

// --- 1. One binary for both architectures.
//
// Each slice keeps its own SEA blob, and therefore its own architecture's
// livekit-server — which is exactly right, since the embedded SFU is a
// native binary too.
const exec = join(macosDir, 'Crewbox')
if (inputs.length === 1) {
  cpSync(inputs[0], exec)
  console.log(`single-architecture build from ${relative(root, inputs[0])}`)
} else {
  run('lipo', ['-create', ...inputs, '-output', exec])
  console.log(`universal binary: ${capture('lipo', ['-archs', exec])}`)
}
chmodSync(exec, 0o755)

// --- 2. Icon.
// sips/iconutil are the two that ship with macOS; no extra tooling.
const iconset = join(outDir, 'Crewbox.iconset')
mkdirSync(iconset, { recursive: true })
const source = join(root, 'web', 'public', 'icon-512.png')
for (const size of [16, 32, 64, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale
    if (px > 1024) continue
    const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`
    run('sips', ['-z', String(px), String(px), source, '--out', join(iconset, name)], {
      stdio: 'ignore',
    })
  }
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(resourcesDir, 'Crewbox.icns')])
rmSync(iconset, { recursive: true, force: true })

// --- 3. Bundle metadata.
//
// The box opens the browser on /setup (first run) or /connect itself, so a
// double-click lands the admin exactly where they need to be with no window
// of our own. LSUIElement is deliberately false: the Dock icon is the only
// visible sign the box is running, and the only way to stop it. That is safe
// here — the store is SQLite in WAL mode and the whole product assumes hard
// power cuts, so being force-quit is a supported way to stop.
writeFileSync(
  join(app, 'Contents', 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Crewbox</string>
  <key>CFBundleDisplayName</key><string>Crewbox</string>
  <key>CFBundleIdentifier</key><string>com.colmhewson.crewbox.box</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>Crewbox</string>
  <key>CFBundleIconFile</key><string>Crewbox</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`
)

// --- 4. Sign, if we have an identity.
//
// Hardened runtime is required for notarisation. The two entitlements are
// what a Node SEA needs: it JITs, and it maps its own embedded blob.
const identity = process.env.MAC_SIGN_IDENTITY
if (identity) {
  const entitlements = join(outDir, 'entitlements.plist')
  writeFileSync(
    entitlements,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict>
</plist>
`
  )
  run('codesign', [
    '--force',
    '--sign',
    identity,
    '--options',
    'runtime',
    '--entitlements',
    entitlements,
    '--timestamp',
    app,
  ])
  run('codesign', ['--verify', '--strict', '--verbose=2', app])
  console.log('signed and verified')
} else {
  console.log('MAC_SIGN_IDENTITY unset — building an unsigned app')
}

const { MAC_NOTARY_APPLE_ID, MAC_NOTARY_PASSWORD, MAC_NOTARY_TEAM_ID } = process.env
const canNotarise = Boolean(MAC_NOTARY_APPLE_ID && MAC_NOTARY_PASSWORD && MAC_NOTARY_TEAM_ID)

/** Submit one file to Apple and block until it comes back. */
const notarise = (target) =>
  run('xcrun', [
    'notarytool',
    'submit',
    target,
    '--apple-id',
    MAC_NOTARY_APPLE_ID,
    '--password',
    MAC_NOTARY_PASSWORD,
    '--team-id',
    MAC_NOTARY_TEAM_ID,
    '--wait',
  ])

// --- 4b. Notarise and staple THE APP, before it goes into the disk image.
//
// This is the step that was missing, and the bug it caused was invisible from
// the build log: we notarised the .dmg and stapled the .dmg, which is true and
// says "notarised and stapled" — but the app dragged out of that image carried
// no ticket of its own. `stapler validate Crewbox.app` on an installed copy
// said so plainly.
//
// It matters here more than for most software. An un-stapled app makes
// Gatekeeper ask Apple on first launch, and a crew box is routinely set up on
// a network that cannot reach Apple at all. Stapling the disk image does not
// help once the app has been copied to /Applications, which is the only thing
// anyone actually does with it.
//
// So: notarise the app itself first, staple it, and only then build the image
// around the stapled copy. Two round trips to Apple rather than one — a few
// minutes of release time to make the product work in a field.
if (identity && canNotarise) {
  // notarytool takes an archive, not a bundle; ditto is what preserves the
  // symlinks and extended attributes a signed .app depends on.
  const zip = join(outDir, 'Crewbox-notarize.zip')
  run('ditto', ['-c', '-k', '--keepParent', app, zip])
  console.log('submitting the app for notarisation (this takes a few minutes)…')
  notarise(zip)
  run('xcrun', ['stapler', 'staple', app])
  run('xcrun', ['stapler', 'validate', app])
  rmSync(zip, { force: true })
  console.log('app notarised and stapled')
}

// --- 5. Disk image.
// A plain read-only image with a symlink to /Applications, which is the
// drag-here convention every Mac user already knows.
const stage = join(outDir, 'dmg')
mkdirSync(stage, { recursive: true })
cpSync(app, join(stage, 'Crewbox.app'), { recursive: true })
run('ln', ['-s', '/Applications', join(stage, 'Applications')])

// Unversioned filename on purpose: the download page and install.sh both
// link through releases/latest/download/<name>, which only resolves for a
// stable asset name. The version travels in the volume name and the bundle.
const dmg = join(outDir, 'Crewbox.dmg')
run('hdiutil', [
  'create',
  '-volname',
  `Crewbox ${version}`,
  '-srcfolder',
  stage,
  '-ov',
  '-format',
  'UDZO',
  dmg,
])
rmSync(stage, { recursive: true, force: true })

if (identity) run('codesign', ['--force', '--sign', identity, '--timestamp', dmg])

// --- 6. Notarise and staple the disk image too.
//
// The app inside is already stapled by this point, so this is about the
// download itself: an un-stapled .dmg makes Gatekeeper phone Apple just to
// open the image, which fails on the same networks that make an un-stapled
// app fail.
if (canNotarise) {
  console.log('submitting the disk image for notarisation…')
  notarise(dmg)
  run('xcrun', ['stapler', 'staple', dmg])
  run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', dmg])

  // Prove it rather than announce it. The previous version printed
  // "notarised and stapled" while the app inside had no ticket — a build log
  // that reads correct is not evidence, so check the artefact.
  run('xcrun', ['stapler', 'validate', dmg])
  console.log('disk image notarised and stapled')
} else {
  console.log('notary credentials unset — the .dmg is not notarised')
}

const sizeMb = (statSync(dmg).size / 1024 / 1024).toFixed(0)
console.log(`\nbuilt ${relative(root, dmg)} (${sizeMb} MB)`)
