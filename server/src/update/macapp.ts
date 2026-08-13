import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Replacing a whole `Crewbox.app` from the signed disk image.
 *
 * A box running inside a bundle cannot be updated the way a bare binary can.
 * Swapping `Contents/Resources/crewbox-server` on its own leaves every other
 * file in the bundle sealed against a hash that no longer matches, and macOS
 * does not treat that as a warning: Gatekeeper refuses to launch the app,
 * from a double-click that offers no explanation and no way forward. A box in
 * a flight case, bricked, at the point somebody most needs it.
 *
 * So the unit of replacement is the `.app` itself, taken from the `.dmg` we
 * signed and notarised — which is also the only artefact that carries a
 * signature Apple will vouch for.
 *
 * **Three details here are load-bearing and none of them are obvious.**
 *
 * `ditto` rather than `cp -R`. Only ditto preserves extended attributes and
 * the resource forks a signature is stored in; `cp -R` produces a bundle that
 * looks right, is byte-identical in every file, and fails `codesign --verify`.
 *
 * `spctl --assess` **after** installing, not only before. The check that
 * matters is whether the app at its final path launches, and a copy that
 * damaged the signature would pass every check made on the mounted image.
 *
 * The disk image is **detached in a `finally`**. A mount left behind survives
 * this process, holds the `.dmg` open, and makes the next attempt fail with a
 * message about a resource being busy that points nowhere near the cause.
 */

/** Where the app is moved to before the new one lands. */
export const OLD_APP_SUFFIX = '.old'

/** How long any one hdiutil/codesign/ditto call gets before it is abandoned. */
export const COMMAND_TIMEOUT_MS = 120_000

export interface MacIo {
  /** Run a command, returning stdout. Throws with stderr on non-zero exit. */
  run: (command: string, args: string[]) => string
  /** A fresh empty directory to mount into. */
  mkdtemp: (prefix: string) => string
  exists: (path: string) => boolean
  /** Whether this process could actually write here. */
  writable: (path: string) => boolean
  rename: (from: string, to: string) => void
  remove: (path: string) => void
}

export const realMacIo: MacIo = {
  run: (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  mkdtemp: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
  exists: (path) => existsSync(path),
  writable: (path) => {
    try {
      accessSync(path, constants.W_OK)
      return true
    } catch {
      return false
    }
  },
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
}

export type MacInstallResult =
  | { ok: true; appPath: string; backupPath: string }
  | {
      ok: false
      reason: string
      stage: 'permission' | 'mount' | 'verify' | 'swap' | 'reverify'
      /**
       * Whether the installed app was ever moved out of the way.
       *
       * Separate from `rolledBack` on purpose, because the two questions have
       * three answers between them and conflating them produces a lie. Most
       * failures here happen *before* anything is touched — an image that will
       * not mount, a directory that cannot be written — and reporting those as
       * "the old app could not be put back" would send somebody hunting for
       * damage that was never done.
       */
      movedAside: boolean
      rolledBack: boolean
    }

export interface MacInstallOptions {
  /** The `.app` to replace, e.g. /Applications/Crewbox.app. */
  appPath: string
  /** The verified `.dmg` `downloadBuild` fetched. */
  dmgPath: string
  /** Name of the app inside the image. Ours is always Crewbox.app. */
  appNameInImage?: string
  io?: MacIo
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
}

/**
 * Put the app from the disk image in place of the running one.
 *
 * Never throws: every failure names the stage it reached and whether the old
 * app is back, because "could not mount the image" and "the new app will not
 * pass Gatekeeper" call for completely different responses from whoever reads
 * it.
 */
export function installMacApp(options: MacInstallOptions): MacInstallResult {
  const io = options.io ?? realMacIo
  const { appPath, dmgPath } = options
  const appName = options.appNameInImage ?? 'Crewbox.app'
  const backupPath = `${appPath}${OLD_APP_SUFFIX}`

  // Checked before anything is mounted or moved. Installing into a directory
  // this process cannot write is a failure worth reporting as "you need to
  // run this differently", not as a mysterious rename error halfway through.
  if (!io.writable(dirname(appPath))) {
    return {
      ok: false,
      stage: 'permission',
      movedAside: false,
      rolledBack: false,
      reason: `${dirname(appPath)} is not writable by this box — an app installed there has to be updated by whoever owns it`,
    }
  }

  let mount: string
  try {
    mount = io.mkdtemp('crewbox-dmg-')
  } catch (err) {
    return { ok: false, stage: 'mount', movedAside: false, rolledBack: false, reason: why(err) }
  }

  let attached = false
  try {
    try {
      // -nobrowse keeps it out of Finder; -readonly because we only ever read
      // from it and a writable mount would let a later step change what was
      // verified.
      io.run('hdiutil', [
        'attach',
        dmgPath,
        '-nobrowse',
        '-readonly',
        '-mountpoint',
        mount,
        '-quiet',
      ])
      attached = true
    } catch (err) {
      return {
        ok: false,
        stage: 'mount',
        movedAside: false,
        rolledBack: false,
        reason: `could not open ${dmgPath}: ${why(err)}`,
      }
    }

    const source = join(mount, appName)
    if (!io.exists(source)) {
      return {
        ok: false,
        stage: 'verify',
        movedAside: false,
        rolledBack: false,
        reason: `${appName} is not inside the disk image`,
      }
    }

    // Gatekeeper's own opinion, before we touch the installed app. Works with
    // no internet because the release is stapled — which matters, since a box
    // that just downloaded an update over a venue's uplink may well have lost
    // it again by now.
    const assessed = assess(io, source)
    if (!assessed.ok) {
      return {
        ok: false,
        stage: 'verify',
        movedAside: false,
        rolledBack: false,
        reason: assessed.reason,
      }
    }

    // Old app aside. A leftover from a previous update would make the rename
    // fail, so it goes first.
    io.remove(backupPath)
    if (io.exists(appPath)) {
      try {
        io.rename(appPath, backupPath)
      } catch (err) {
        return {
          ok: false,
          stage: 'swap',
          movedAside: false,
          rolledBack: false,
          reason: `could not move the current app aside: ${why(err)}`,
        }
      }
    }

    try {
      // ditto, not cp: the signature lives in extended attributes that cp -R
      // silently drops, producing a bundle that looks perfect and will not
      // launch.
      io.run('ditto', [source, appPath])
    } catch (err) {
      const back = restore(io, backupPath, appPath)
      return {
        ok: false,
        stage: 'swap',
        movedAside: true,
        rolledBack: back,
        reason: `could not copy the new app into place: ${why(err)}`,
      }
    }

    // The check that actually matters: the app at its final path, after the
    // copy. A copy that damaged the signature would have passed every check
    // made on the mounted image.
    const installed = assess(io, appPath)
    if (!installed.ok) {
      io.remove(appPath)
      const back = restore(io, backupPath, appPath)
      return {
        ok: false,
        stage: 'reverify',
        movedAside: true,
        rolledBack: back,
        reason: `the installed app does not pass Gatekeeper (${installed.reason}) — put the old one back`,
      }
    }

    options.log?.info(`update: replaced ${appPath} from ${dmgPath}`)
    return { ok: true, appPath, backupPath }
  } finally {
    // Always. A mount left behind outlives this process, holds the image
    // open, and makes the next attempt fail with a message about a busy
    // resource that points nowhere near the cause.
    if (attached) {
      try {
        io.run('hdiutil', ['detach', mount, '-quiet'])
      } catch {
        try {
          io.run('hdiutil', ['detach', mount, '-force', '-quiet'])
        } catch {
          options.log?.warn(`update: could not unmount ${mount} — unmount it by hand`)
        }
      }
    }
    try {
      io.remove(mount)
    } catch {
      /* an empty temp directory is not worth a word */
    }
  }
}

/**
 * Both halves of Apple's opinion.
 *
 * `codesign --verify` says the bundle is intact and internally consistent.
 * `spctl --assess` says the system would actually let it run — notarisation,
 * revocation, policy. They disagree in exactly the case that matters: a
 * correctly signed app whose certificate has been pulled passes the first and
 * fails the second.
 */
function assess(io: MacIo, app: string): { ok: true } | { ok: false; reason: string } {
  try {
    io.run('codesign', ['--verify', '--deep', '--strict', app])
  } catch (err) {
    return { ok: false, reason: `signature check failed: ${why(err)}` }
  }
  try {
    io.run('spctl', ['--assess', '--type', 'execute', app])
  } catch (err) {
    return { ok: false, reason: `Gatekeeper refused it: ${why(err)}` }
  }
  return { ok: true }
}

/** Put the old app back. Returns whether it worked. */
function restore(io: MacIo, backupPath: string, appPath: string): boolean {
  if (!io.exists(backupPath)) return false
  try {
    io.remove(appPath)
    io.rename(backupPath, appPath)
    return true
  } catch {
    return false
  }
}

/**
 * How to start a bundle again.
 *
 * `open` rather than running `Contents/MacOS/Crewbox` directly: the bundle's
 * executable is the menu-bar wrapper, and launching it outside of LaunchServices
 * gives a process with no menu bar, no Dock identity and no way to be quit —
 * which is the problem the wrapper exists to solve.
 *
 * `-n` forces a new instance rather than activating the one that is on its
 * way out.
 */
export function relaunchCommand(appPath: string): { command: string; args: string[] } {
  return { command: 'open', args: ['-n', appPath] }
}

function why(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim()
    if (stderr) return stderr.split('\n')[0]!
  }
  return err instanceof Error ? err.message : String(err)
}
