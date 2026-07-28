// Compile the macOS menu-bar wrapper (native/macos/CrewboxMenuBar.swift).
//
// Usage: node scripts/build-menubar.mjs <output> [arch…]
//   arch defaults to arm64 and x86_64, matching a universal box.
//
// Its own script for the same reason as build-tray.mjs: the release build and
// the CI check have to run the same command, or the check drifts from the
// thing it is checking and stops meaning anything.
//
// swiftc ships with the Xcode command line tools, which anyone building the
// .app already needs for codesign.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Compile the wrapper for `archs` to `out`. Returns the path. */
export function buildMenuBar(out, archs = ['arm64', 'x86_64']) {
  mkdirSync(dirname(out), { recursive: true })
  execFileSync(
    'swiftc',
    [
      ...archs.flatMap((arch) => ['-target', `${arch}-apple-macos11.0`]),
      '-O',
      // The bundle is signed as a whole later; an ad-hoc signature here would
      // only be replaced.
      '-Xlinker',
      '-no_adhoc_codesign',
      '-o',
      out,
      join(root, 'native', 'macos', 'CrewboxMenuBar.swift'),
    ],
    { stdio: 'inherit' }
  )
  return out
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  if (process.platform !== 'darwin') {
    console.error('build-menubar.mjs only runs on macOS')
    process.exit(1)
  }
  const out = process.argv[2] ?? join(root, 'build', 'mac', 'CrewboxMenuBar')
  const archs = process.argv.slice(3)
  buildMenuBar(out, archs.length > 0 ? archs : undefined)
  const archList = execFileSync('lipo', ['-archs', out], { encoding: 'utf8' }).trim()
  console.log(`built ${out} (${archList})`)
}
