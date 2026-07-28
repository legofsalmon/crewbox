// Compile the Windows tray helper (native/windows/CrewboxTray.cs).
//
// Usage: node scripts/build-tray.mjs [output.exe]
//
// Its own script so the release build and CI run the same command. The first
// version of the CI check re-implemented the csc invocation in bash and broke
// on something the real build never hits: MSYS path conversion rewrites
// /nologo into C:/Program Files/Git/nologo. A check that can fail for reasons
// the thing it checks cannot is worse than no check, so there is now exactly
// one place that knows how to build this.
//
// csc.exe comes with the .NET Framework, which is on every Windows 10 and 11
// machine — nothing to install, and about 15 KB of output.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Path to the framework C# compiler, or null when this isn't Windows. */
export function cscPath() {
  if (process.platform !== 'win32') return null
  const csc = join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe'
  )
  return existsSync(csc) ? csc : null
}

/**
 * Compile the tray helper to `out`. Returns the path, or null when csc is
 * unavailable — the caller decides whether that is fatal. It isn't for the
 * box build (a box with no tray icon still works) and it is for CI.
 */
export function buildTray(out) {
  const csc = cscPath()
  if (!csc) return null
  mkdirSync(dirname(out), { recursive: true })
  // execFileSync, not a shell: the arguments start with / and any shell that
  // thinks it is helping with paths will mangle them.
  execFileSync(
    csc,
    [
      '/nologo',
      '/target:winexe',
      '/optimize+',
      `/out:${out}`,
      '/reference:System.dll',
      '/reference:System.Drawing.dll',
      '/reference:System.Windows.Forms.dll',
      '/reference:System.Runtime.Serialization.dll',
      join(root, 'native', 'windows', 'CrewboxTray.cs'),
    ],
    { stdio: 'inherit' }
  )
  return out
}

// Run directly: compile, and fail loudly. This is the CI entry point, so an
// absent compiler is an error here even though it is tolerable in a build.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  if (process.platform !== 'win32') {
    console.error('build-tray.mjs only runs on Windows')
    process.exit(1)
  }
  if (!cscPath()) {
    console.error('no csc.exe found — is the .NET Framework present?')
    process.exit(1)
  }
  // Never build/box: the release globs build/box/crewbox-* into its assets.
  const out = process.argv[2] ?? join(root, 'build', 'tray', 'crewbox-tray.exe')
  buildTray(out)
  console.log(`built ${out}`)
}
