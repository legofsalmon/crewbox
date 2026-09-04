import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { OLD_APP_SUFFIX, installMacApp, relaunchCommand, type MacIo } from './macapp.ts'

/**
 * Putting a verified build in place of the running one, and being able to
 * undo it.
 *
 * The whole design turns on one fact: **you cannot overwrite a running
 * executable, but you can rename it.** Linux returns ETXTBSY on a write to
 * the file backing a live process; Windows refuses to delete or overwrite a
 * loaded image. Both allow a rename, and both keep serving the already-open
 * image afterwards. So an install is never a write-over-the-top — it is
 * always: move the old one aside, move the new one in, and keep the old one
 * where a rollback can find it.
 *
 * That ordering is also what makes the failure modes survivable. At every
 * instant between the first rename and the last, there is a complete, working
 * binary on disk under a known name. There is no window in which the box is a
 * half-written file.
 *
 * **Nothing here restarts anything or decides anything.** It swaps files and
 * says how to put them back. Choosing to install, deciding when, watching the
 * new process and pulling the handle are all somebody else's job — which
 * keeps every decision in this file testable without spawning a process.
 */

/** What the old binary is renamed to. Swept at startup once it is not needed. */
export const OLD_SUFFIX = '.old'

/** Records an install that started and has not yet been confirmed good. */
export const IN_FLIGHT_FILE = 'install-in-flight.json'

/**
 * What kind of thing this box is, and therefore how it gets replaced.
 *
 * The distinction that matters is not the operating system, it is whether the
 * running binary is a file somebody can swap or a file *inside a code-signed
 * bundle*. Replacing `Crewbox.app/Contents/Resources/crewbox-server` on its
 * own breaks the bundle's signature, and a broken signature on macOS is not a
 * warning — Gatekeeper kills the process on next launch, from a double-click
 * that gives no reason. That is a bricked box, undone only by somebody with a
 * terminal and the knowledge to use it.
 *
 * So a bundle is a different operation entirely: replace the whole `.app`
 * from the signed, notarised `.dmg`. That lives in `macapp.ts`, and this type
 * is what routes to it — the difference is stated in the code rather than
 * left to be discovered.
 */
export type InstallTarget =
  { kind: 'binary'; path: string } | { kind: 'app-bundle'; appPath: string; execPath: string }

/**
 * Work out what is running, from the path it is running as.
 *
 * `.app` bundles are recognised by structure rather than by platform: a
 * darwin box run straight from a download is an ordinary binary and updates
 * like one, and only a box living inside `Something.app/Contents/` needs the
 * bundle treatment.
 */
export function detectTarget(execPath: string, platform: NodeJS.Platform): InstallTarget {
  if (platform === 'darwin') {
    // Walk up looking for a `.app` directory. Matching on the string alone
    // would be fooled by a data directory called `notes.app`; requiring the
    // `Contents` segment underneath it is what makes this a bundle.
    const marker = '.app/Contents/'
    const at = execPath.indexOf(marker)
    if (at !== -1) {
      return { kind: 'app-bundle', appPath: execPath.slice(0, at + '.app'.length), execPath }
    }
  }
  return { kind: 'binary', path: execPath }
}

export interface InFlight {
  /** The version that was running when the install started. */
  fromVersion: string
  /** The version that was put in its place. */
  toVersion: string
  /**
   * What was replaced: a plain file, or a whole `.app` directory.
   *
   * Carried rather than re-derived, because the rollback runs in a *different
   * process* from the install — possibly a differently-built one, after a
   * power cut — and asking "what am I?" again there could get a different
   * answer than the install acted on.
   */
  kind: InstallTarget['kind']
  /** The binary, or the bundle, that was replaced. */
  targetPath: string
  /** Where the replaced one was moved to. */
  backupPath: string
  /** The database copy taken first, when there was one. */
  snapshotPath: string | null
  /**
   * Where the verified download came from, when it is known.
   *
   * The swap is a rename, so after it there is no copy left in the updates
   * directory — and a rollback that simply deleted the installed file threw
   * away the one thing "Try again" needs, turning every retry into another
   * two-hundred-megabyte download over a venue's uplink. `undoInstall` puts
   * it back here instead. Optional because a marker written by an older box
   * will not have it, and a marker that fails to parse is a rollback that
   * cannot happen.
   */
  buildPath?: string
  /**
   * How to start it again. A bare binary is its own launcher; a bundle has
   * to go through `open`, or LaunchServices never hears about it and the
   * menu bar never appears.
   */
  relaunch: { command: string; args: string[] }
  startedAt: number
}

export type InstallResult =
  | { ok: true; inFlight: InFlight }
  | { ok: false; reason: string; stage: 'unsupported' | 'missing' | 'swap' }

export interface InstallOptions {
  target: InstallTarget
  /** The verified file downloaded by `downloadBuild`. */
  buildPath: string
  fromVersion: string
  toVersion: string
  dataDir: string
  snapshotPath?: string | null
  now?: () => number
  /** Overridable so the macOS path is testable without a Mac. */
  macIo?: MacIo
}

/**
 * Move the new build into place, keeping the old one.
 *
 * On success the box on disk is the new version and the old one is beside it
 * under `.old`; the returned record is everything `undoInstall` needs. The
 * marker is written to the data directory *before* the swap, so a box that
 * loses power midway still knows on next start that an install was in flight.
 */
export function installBuild(options: InstallOptions): InstallResult {
  const { target, buildPath, dataDir } = options
  const at = (options.now ?? Date.now)()

  // A bundle is a different operation entirely — the whole `.app` comes off
  // the signed disk image — so it goes to its own module rather than being
  // bent into the rename dance below.
  if (target.kind === 'app-bundle') {
    return installBundle(options, target, at)
  }
  if (!existsSync(buildPath)) {
    return { ok: false, stage: 'missing', reason: `${buildPath} is not there to install` }
  }
  if (!existsSync(target.path)) {
    return { ok: false, stage: 'missing', reason: `${target.path} is not there to replace` }
  }

  const backupPath = `${target.path}${OLD_SUFFIX}`
  const inFlight: InFlight = {
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    kind: 'binary',
    targetPath: target.path,
    backupPath,
    snapshotPath: options.snapshotPath ?? null,
    buildPath,
    relaunch: { command: target.path, args: [] },
    startedAt: at,
  }

  // Written first. If the power goes between here and the end of the swap,
  // the next start finds this and knows to look; without it, a box that came
  // up on a half-finished install would have nothing to reason from.
  try {
    writeInFlight(dataDir, inFlight)
  } catch (err) {
    return { ok: false, stage: 'swap', reason: `could not record the install: ${reason(err)}` }
  }

  // A leftover `.old` from a previous update would make the rename fail on
  // Windows, which refuses to rename onto an existing name.
  try {
    rmSync(backupPath, { force: true })
  } catch {
    // If it will not go, the rename below fails and reports it properly.
  }

  try {
    renameSync(target.path, backupPath)
  } catch (err) {
    clearInFlight(dataDir)
    return {
      ok: false,
      stage: 'swap',
      reason: `could not move the running box aside: ${reason(err)}`,
    }
  }

  try {
    // The one move here that can cross a filesystem: the download lives under
    // the data directory and the binary does not have to.
    moveFile(buildPath, target.path)
  } catch (err) {
    // Put it back rather than leaving a box with no binary at its own path.
    // This is the one failure that would otherwise be unrecoverable without
    // a second machine.
    try {
      renameSync(backupPath, target.path)
    } catch {
      return {
        ok: false,
        stage: 'swap',
        reason: `could not install the new box, and could not put the old one back — it is at ${backupPath}`,
      }
    }
    clearInFlight(dataDir)
    return {
      ok: false,
      stage: 'swap',
      reason: `could not put the new box in place: ${reason(err)}`,
    }
  }

  // A rename across the same filesystem keeps the download's mode, which is
  // whatever `writeFile` produced — not executable. Windows does not care;
  // everything else does, and the failure would be a box that cannot start.
  try {
    chmodSync(target.path, 0o755)
  } catch {
    // Windows, or a filesystem with no modes. The rename already succeeded,
    // so failing here would undo a good install over a no-op.
  }

  return { ok: true, inFlight }
}

/**
 * The macOS bundle path: hand the whole `.app` over to the disk-image swap.
 *
 * `installMacApp` does its own backup and its own rollback, so this writes
 * the marker first and then records what it did — the marker is what a later
 * process needs to undo it, and it has to exist before anything moves.
 */
function installBundle(
  options: InstallOptions,
  target: Extract<InstallTarget, { kind: 'app-bundle' }>,
  at: number
): InstallResult {
  const { dataDir, buildPath } = options
  const backupPath = `${target.appPath}${OLD_APP_SUFFIX}`
  const inFlight: InFlight = {
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    kind: 'app-bundle',
    targetPath: target.appPath,
    backupPath,
    snapshotPath: options.snapshotPath ?? null,
    relaunch: relaunchCommand(target.appPath),
    startedAt: at,
  }

  try {
    writeInFlight(dataDir, inFlight)
  } catch (err) {
    return { ok: false, stage: 'swap', reason: `could not record the install: ${reason(err)}` }
  }

  const installed = installMacApp({
    appPath: target.appPath,
    dmgPath: buildPath,
    ...(options.macIo ? { io: options.macIo } : {}),
  })
  if (!installed.ok) {
    // installMacApp has already put the old app back where it could. Clearing
    // the marker matters: leaving one behind would have the next start try to
    // undo an install that has already been undone.
    clearInFlight(dataDir)
    // The alarming suffix is earned only when the app really was moved and
    // really is still missing. Most failures happen before anything is
    // touched, and telling somebody their app could not be put back when it
    // never left would send them hunting for damage that was never done.
    const stranded = installed.movedAside && !installed.rolledBack
    return {
      ok: false,
      stage: installed.stage === 'permission' ? 'unsupported' : 'swap',
      reason: stranded
        ? `${installed.reason} — and the old app could not be put back; it is at ${backupPath}`
        : installed.reason,
    }
  }
  return { ok: true, inFlight }
}

/**
 * Put the old box back.
 *
 * Used both by the process supervising a restart when the new build will not
 * come up, and at startup when a marker says an install was never confirmed.
 *
 * Works for a bundle as well as a binary: a `.app` is a directory, so the
 * removal has to be recursive and there is no mode to restore.
 */
export function undoInstall(
  inFlight: InFlight,
  dataDir: string
): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(inFlight.backupPath)) {
    return { ok: false, reason: `there is no ${inFlight.backupPath} to go back to` }
  }
  try {
    // The failed new build is in the way, and it is the only copy: the swap
    // moved it out of the updates directory rather than copying it. Put it
    // back there, so "Try again" is a rename and not another two hundred
    // megabytes over a venue's uplink. A bundle has no download to return —
    // `installMacApp` owns that path — and anything that goes wrong here is
    // not worth failing a rollback over.
    let returned = false
    if (inFlight.kind !== 'app-bundle' && inFlight.buildPath) {
      try {
        // Windows will not rename onto an existing name, and the swap should
        // have left nothing here anyway.
        rmSync(inFlight.buildPath, { force: true })
        moveFile(inFlight.targetPath, inFlight.buildPath)
        returned = true
      } catch {
        // Out of space, or a directory that has gone. It is a download, and
        // the box being on the right binary matters more.
      }
    }
    if (!returned) rmSync(inFlight.targetPath, { force: true, recursive: true })
    renameSync(inFlight.backupPath, inFlight.targetPath)
    // A bundle has no single executable bit to put back — the signature and
    // the modes inside it came over with the directory.
    if (inFlight.kind !== 'app-bundle') chmodSync(inFlight.targetPath, 0o755)
  } catch (err) {
    return { ok: false, reason: `could not restore the old box: ${reason(err)}` }
  }
  clearInFlight(dataDir)
  return { ok: true }
}

/** Forget the backup once the new build has proved itself. */
export function dropBackup(inFlight: InFlight, dataDir: string): void {
  try {
    rmSync(inFlight.backupPath, { force: true, recursive: true })
  } catch {
    // A `.old` that will not delete is clutter, not a problem. The startup
    // sweep will try again.
  }
  clearInFlight(dataDir)
}

export function inFlightPath(dataDir: string): string {
  return join(dataDir, IN_FLIGHT_FILE)
}

export function writeInFlight(dataDir: string, inFlight: InFlight): void {
  writeFileSync(inFlightPath(dataDir), JSON.stringify(inFlight, null, 2))
}

/** The record of an unfinished install, or null. Tolerates any junk. */
export function readInFlight(dataDir: string): InFlight | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(inFlightPath(dataDir), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Partial<InFlight>
    if (
      typeof r.fromVersion !== 'string' ||
      typeof r.toVersion !== 'string' ||
      typeof r.targetPath !== 'string' ||
      typeof r.backupPath !== 'string' ||
      typeof r.startedAt !== 'number'
    ) {
      return null
    }
    // `kind` and `relaunch` are defaulted rather than required. A marker can
    // outlive the build that wrote it — that is the whole point of it — and a
    // box mid-rollback should not be defeated by a field its predecessor did
    // not know to write. A plain binary that launches itself is the older
    // behaviour and the safe assumption.
    const relaunch =
      typeof r.relaunch === 'object' &&
      r.relaunch !== null &&
      typeof r.relaunch.command === 'string' &&
      Array.isArray(r.relaunch.args)
        ? {
            command: r.relaunch.command,
            args: r.relaunch.args.filter((a) => typeof a === 'string'),
          }
        : { command: r.targetPath, args: [] }
    return {
      fromVersion: r.fromVersion,
      toVersion: r.toVersion,
      kind: r.kind === 'app-bundle' ? 'app-bundle' : 'binary',
      targetPath: r.targetPath,
      backupPath: r.backupPath,
      snapshotPath: typeof r.snapshotPath === 'string' ? r.snapshotPath : null,
      // Optional for the same reason as `relaunch`: a marker can outlive the
      // build that wrote it. Without it a rollback deletes the download
      // instead of returning it, which costs a retry and nothing else.
      ...(typeof r.buildPath === 'string' ? { buildPath: r.buildPath } : {}),
      relaunch,
      startedAt: r.startedAt,
    }
  } catch {
    return null
  }
}

export function clearInFlight(dataDir: string): void {
  try {
    rmSync(inFlightPath(dataDir), { force: true })
  } catch {
    /* nothing here is worth failing a start over */
  }
}

/**
 * Are these two strings the same crewbox version?
 *
 * Three notations for one thing are in play and none of them can be compared
 * raw. A release is tagged `v0.19.0`; the in-flight marker stores whatever
 * tag it was asked to install; a running box reports `0.19.0+def5678`,
 * because the commit is part of what it is. Comparing the numeric version
 * only is deliberate — the suffix is not knowable from a tag, and a box that
 * installed perfectly but reported an unexpected one would otherwise be
 * treated as a stranger.
 */
export function sameVersion(a: string, b: string): boolean {
  const strip = (v: string) => v.replace(/^v/, '').split('+')[0]!.trim()
  return strip(a) === strip(b)
}

/**
 * Move a file, including onto a different filesystem.
 *
 * `renameSync` is the whole reason an install is survivable — it is atomic,
 * and it works on a file that is currently executing. But it only works
 * within one filesystem, and the two paths here are the data directory and
 * wherever the binary lives. A box with `/usr/local/bin/crewbox` and its data
 * on `/home`, or on a USB stick, is an ordinary layout and an EXDEV every
 * time: the update simply could not be installed, with a message about a
 * rename nobody would connect to the cause.
 *
 * So: try the rename, and on EXDEV only, copy and remove. The copy is not
 * atomic, which is why it is the fallback and not the method — every caller
 * that can use a rename still does.
 */
export function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    copyFileSync(from, to)
    rmSync(from, { force: true })
  }
}

export type RecoveryOutcome =
  | { action: 'none' }
  | { action: 'supervised'; pid: number; toVersion: string }
  | { action: 'confirmed'; toVersion: string }
  | { action: 'rolled-back'; toVersion: string; fromVersion: string }
  | { action: 'failed'; reason: string }

/**
 * What to do about an install nobody ever confirmed.
 *
 * **First: is anybody already doing it?** Every successful update reaches
 * this function, because the box the updater has just launched runs the same
 * startup as any other — and that box must not touch a thing. The process
 * that swapped the binary is alive, holds the only reference to the backup,
 * and is at this moment polling `/api/health` to decide whether to keep this
 * build or put the old one back. A newly launched box that "recovered" would
 * delete the backup out from under the one process that can still use it, and
 * a build that then failed its probe would have nothing to go back to. So a
 * live supervisor means: report it, and leave.
 *
 * Otherwise this is the case the name describes — the supervising process
 * died between swapping the binary and seeing the new one answer, a power cut
 * or somebody closing the lid at exactly the wrong moment. The question is
 * whether the box now starting is the new build or the old one, and **the
 * running version answers it**:
 *
 *  - Running the new version: the swap worked and the box is up. Nobody
 *    confirmed it, but it is plainly alive — clear the marker and keep the
 *    build. Rolling back a box that is working would be the bug.
 *  - Running the old version: the swap never took, or something put it back.
 *    Restore properly so no `.old` is left lying around half-applied.
 *
 * Anything else — a version matching neither — is a box nobody can reason
 * about from here, so it says so rather than guessing which way to jump.
 *
 * The comparison is `sameVersion`, not `===`: a marker records the release
 * tag it was asked to install (`v0.19.0`) and a running box reports its own
 * build (`0.19.0+def5678`). Comparing those raw matches neither branch, which
 * sent every interrupted install down the "cannot reason about this" path.
 */
export function recoverInterruptedInstall(
  dataDir: string,
  runningVersion: string,
  /** Another crewbox already running and watching this one, if there is one. */
  supervisor: number | null = null
): RecoveryOutcome {
  const inFlight = readInFlight(dataDir)
  if (!inFlight) return { action: 'none' }

  if (supervisor !== null) {
    return { action: 'supervised', pid: supervisor, toVersion: inFlight.toVersion }
  }

  if (sameVersion(runningVersion, inFlight.toVersion)) {
    dropBackup(inFlight, dataDir)
    return { action: 'confirmed', toVersion: inFlight.toVersion }
  }
  if (sameVersion(runningVersion, inFlight.fromVersion)) {
    const undone = undoInstall(inFlight, dataDir)
    if (!undone.ok) {
      clearInFlight(dataDir)
      return { action: 'failed', reason: undone.reason }
    }
    return {
      action: 'rolled-back',
      toVersion: inFlight.toVersion,
      fromVersion: inFlight.fromVersion,
    }
  }
  clearInFlight(dataDir)
  return {
    action: 'failed',
    reason: `an install of ${inFlight.toVersion} was interrupted, but this box is running ${runningVersion} — leaving ${inFlight.backupPath} alone`,
  }
}

/**
 * Remove `.old` files left beside a binary.
 *
 * Windows in particular cannot delete the image it is running, so the
 * previous binary survives until something deletes it later — which is this,
 * on the next start, when it is no longer anybody's running image.
 *
 * Deliberately does nothing while an install is in flight: that `.old` is the
 * only way back.
 */
export function sweepOldBinaries(dataDir: string, execPath: string): string[] {
  if (readInFlight(dataDir)) return []
  const removed: string[] = []
  const candidate = `${execPath}${OLD_SUFFIX}`
  try {
    if (existsSync(candidate)) {
      rmSync(candidate, { force: true })
      removed.push(candidate)
    }
  } catch {
    // Still running, still locked, or not ours to delete. It is a stale file
    // next to a working box — try again next start.
  }
  return removed
}

/** Where a box's binary lives, for a caller that wants the directory. */
export function targetDir(target: InstallTarget): string {
  return dirname(target.kind === 'binary' ? target.path : target.appPath)
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
