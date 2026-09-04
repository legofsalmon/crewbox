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
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * Compile the wrapper for `archs` to `out`. Returns the path.
 *
 * One swiftc run per architecture, then lipo. This is not the obvious way to
 * write it and the obvious way is wrong: `-target` takes a single triple, and
 * passing it twice does not produce a universal binary — the last one silently
 * wins. That shipped an x86_64-only wrapper past a green CI job, which on a
 * clean Apple Silicon Mac is an app that will not launch at all.
 */
export function buildMenuBar(out, archs = ['arm64', 'x86_64']) {
  mkdirSync(dirname(out), { recursive: true })
  const source = join(root, 'native', 'macos', 'CrewboxMenuBar.swift')
  const slices = archs.map((arch) => {
    const slice = `${out}.${arch}`
    execFileSync(
      'swiftc',
      [
        '-target',
        `${arch}-apple-macos11.0`,
        '-O',
        // The bundle is signed as a whole later; an ad-hoc signature here
        // would only be replaced.
        '-Xlinker',
        '-no_adhoc_codesign',
        '-o',
        slice,
        source,
      ],
      { stdio: 'inherit' }
    )
    return slice
  })

  if (slices.length === 1) {
    renameSync(slices[0], out)
  } else {
    execFileSync('lipo', ['-create', ...slices, '-output', out], { stdio: 'inherit' })
    for (const slice of slices) rmSync(slice, { force: true })
  }

  // Assert rather than announce. The previous version printed the architecture
  // it had produced and carried on regardless, so a single-slice build read as
  // a pass — the check has to fail, not report.
  const built = execFileSync('lipo', ['-archs', out], { encoding: 'utf8' }).trim().split(/\s+/)
  const missing = archs.filter((arch) => !built.includes(arch))
  if (missing.length > 0) {
    throw new Error(
      `menu-bar wrapper is missing ${missing.join(', ')} — built only ${built.join(', ')}`
    )
  }
  return out
}

// Run directly, rather than imported.
//
// `import.meta.url.endsWith(argv[1])` compared a percent-encoded file URL
// with a raw filesystem path, so a checkout under a directory with a space
// or an accent in it never matched — and the script did nothing at all,
// silently, reporting success. That is the CI entry point for the Windows
// tray and the macOS menu bar: a build would come out without one and
// nothing would say so.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
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
