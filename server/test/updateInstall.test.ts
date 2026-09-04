import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OLD_SUFFIX,
  clearInFlight,
  detectTarget,
  dropBackup,
  inFlightPath,
  installBuild,
  moveFile,
  readInFlight,
  recoverInterruptedInstall,
  sweepOldBinaries,
  undoInstall,
  writeInFlight,
  type InFlight,
} from '../src/update/install.ts'
import type { MacIo } from '../src/update/macapp.ts'
import { schemaVersion, snapshotDb } from '../src/update/snapshot.ts'
import { DatabaseSync } from 'node:sqlite'

/**
 * Swapping the binary, and getting back.
 *
 * The invariant every test here defends: **at no point is there no working
 * box on disk.** Before the swap the old one is at its own path; between the
 * two renames it is at `.old`; after them the new one is in place and the old
 * one is still at `.old`. A test that ever finds neither has found the bug
 * that matters.
 */

let dir: string
let target: string
let build: string
let dataDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-install-'))
  dataDir = join(dir, 'data')
  mkdirSync(dataDir, { recursive: true })
  target = join(dir, 'crewbox')
  build = join(dir, 'updates', 'crewbox-linux-x64-v0.18.0')
  mkdirSync(join(dir, 'updates'), { recursive: true })
  writeFileSync(target, 'the old box')
  chmodSync(target, 0o755)
  writeFileSync(build, 'the new box')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A Mac that says yes to everything, recording what it was asked to do. */
const fakeMacIo = (calls: string[]): MacIo => ({
  run: (command, args) => {
    calls.push([command, ...args].join(' '))
    return ''
  },
  mkdtemp: () => '/tmp/crewbox-dmg-x',
  exists: () => true,
  writable: () => true,
  rename: () => {},
  remove: () => {},
})

const install = () =>
  installBuild({
    target: { kind: 'binary', path: target },
    buildPath: build,
    fromVersion: '0.17.1',
    toVersion: '0.18.0',
    dataDir,
    now: () => 1_700_000_000_000,
  })

describe('what is running, and how it gets replaced', () => {
  it('treats a plain binary as a plain binary', () => {
    expect(detectTarget('/opt/crewbox/crewbox', 'linux')).toEqual({
      kind: 'binary',
      path: '/opt/crewbox/crewbox',
    })
    expect(detectTarget('C:\\crewbox\\crewbox.exe', 'win32')).toEqual({
      kind: 'binary',
      path: 'C:\\crewbox\\crewbox.exe',
    })
  })

  it('recognises a box living inside a signed .app', () => {
    expect(
      detectTarget('/Applications/Crewbox.app/Contents/Resources/crewbox-server', 'darwin')
    ).toEqual({
      kind: 'app-bundle',
      appPath: '/Applications/Crewbox.app',
      execPath: '/Applications/Crewbox.app/Contents/Resources/crewbox-server',
    })
  })

  it('treats a downloaded darwin binary as a binary, not a bundle', () => {
    // A Mac box run straight from a download is an ordinary file and updates
    // like one. Only a bundle needs the bundle treatment.
    expect(detectTarget('/Users/colm/Downloads/crewbox-darwin-arm64', 'darwin')).toEqual({
      kind: 'binary',
      path: '/Users/colm/Downloads/crewbox-darwin-arm64',
    })
  })

  it('is not fooled by a directory that merely ends in .app', () => {
    expect(detectTarget('/data/notes.app/crewbox', 'darwin')).toEqual({
      kind: 'binary',
      path: '/data/notes.app/crewbox',
    })
  })

  it('sends a bundle to the disk-image swap, not the rename dance', () => {
    // Replacing the binary inside a signed .app leaves Gatekeeper killing it
    // on next launch. A bundle is replaced whole, from the .dmg.
    const calls: string[] = []
    const result = installBuild({
      target: {
        kind: 'app-bundle',
        appPath: '/Applications/Crewbox.app',
        execPath: '/Applications/Crewbox.app/Contents/Resources/crewbox-server',
      },
      buildPath: build,
      fromVersion: '0.17.1',
      toVersion: '0.18.0',
      dataDir,
      macIo: fakeMacIo(calls),
    })
    expect(result.ok).toBe(true)
    expect(calls.some((c) => c.startsWith('ditto'))).toBe(true)
    if (!result.ok) return
    expect(result.inFlight.kind).toBe('app-bundle')
    expect(result.inFlight.targetPath).toBe('/Applications/Crewbox.app')
  })

  it('records that a bundle restarts through open', () => {
    // The bundle's executable is the menu-bar wrapper; starting it directly
    // gives a box with no menu bar and no way to quit it.
    const result = installBuild({
      target: {
        kind: 'app-bundle',
        appPath: '/Applications/Crewbox.app',
        execPath: '/Applications/Crewbox.app/Contents/Resources/crewbox-server',
      },
      buildPath: build,
      fromVersion: '0.17.1',
      toVersion: '0.18.0',
      dataDir,
      macIo: fakeMacIo([]),
    })
    if (!result.ok) return
    expect(result.inFlight.relaunch).toEqual({
      command: 'open',
      args: ['-n', '/Applications/Crewbox.app'],
    })
  })

  it('does not claim the old app is lost when nothing was ever moved', () => {
    // A permission failure happens before anything is touched. Saying "the
    // old app could not be put back" would send somebody hunting for damage
    // that was never done.
    const result = installBuild({
      target: {
        kind: 'app-bundle',
        appPath: '/Applications/Crewbox.app',
        execPath: '/Applications/Crewbox.app/Contents/Resources/crewbox-server',
      },
      buildPath: build,
      fromVersion: '0.17.1',
      toVersion: '0.18.0',
      dataDir,
      macIo: { ...fakeMacIo([]), writable: () => false },
    })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.reason).toContain('not writable')
    expect(result.reason).not.toContain('could not be put back')
  })

  it('leaves no marker behind when the bundle swap fails', () => {
    const io = fakeMacIo([])
    installBuild({
      target: {
        kind: 'app-bundle',
        appPath: '/Applications/Crewbox.app',
        execPath: '/Applications/Crewbox.app/Contents/Resources/crewbox-server',
      },
      buildPath: build,
      fromVersion: '0.17.1',
      toVersion: '0.18.0',
      dataDir,
      macIo: { ...io, writable: () => false },
    })
    expect(existsSync(inFlightPath(dataDir))).toBe(false)
  })
})

describe('installing', () => {
  it('puts the new box in place and keeps the old one', () => {
    const result = install()
    expect(result.ok).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('the new box')
    expect(readFileSync(`${target}${OLD_SUFFIX}`, 'utf8')).toBe('the old box')
  })

  it('leaves the installed box executable', () => {
    // A rename keeps the download's mode, which is not executable. Getting
    // this wrong ships a box that cannot start.
    install()
    expect(statSync(target).mode & 0o111).toBeTruthy()
  })

  it('records the install before touching anything', () => {
    const result = install()
    expect(result.ok).toBe(true)
    const marker = readInFlight(dataDir)
    expect(marker).toMatchObject({
      fromVersion: '0.17.1',
      toVersion: '0.18.0',
      targetPath: target,
      backupPath: `${target}${OLD_SUFFIX}`,
    })
  })

  it('replaces a leftover .old from a previous update', () => {
    // Windows refuses to rename onto an existing name, so a stale backup
    // would fail every future install on that platform.
    writeFileSync(`${target}${OLD_SUFFIX}`, 'ancient history')
    expect(install().ok).toBe(true)
    expect(readFileSync(`${target}${OLD_SUFFIX}`, 'utf8')).toBe('the old box')
  })

  it('says so when the download is not there', () => {
    rmSync(build)
    expect(install()).toMatchObject({ ok: false, stage: 'missing' })
  })

  it('leaves no marker behind when it could not start', () => {
    rmSync(build)
    install()
    expect(existsSync(inFlightPath(dataDir))).toBe(false)
  })
})

describe('going back', () => {
  it('restores the old box', () => {
    const result = install()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(undoInstall(result.inFlight, dataDir)).toEqual({ ok: true })
    expect(readFileSync(target, 'utf8')).toBe('the old box')
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(false)
    expect(existsSync(inFlightPath(dataDir))).toBe(false)
  })

  it('leaves the restored box executable too', () => {
    const result = install()
    if (!result.ok) return
    undoInstall(result.inFlight, dataDir)
    expect(statSync(target).mode & 0o111).toBeTruthy()
  })

  it('says why when there is nothing to go back to', () => {
    const result = install()
    if (!result.ok) return
    rmSync(result.inFlight.backupPath)
    expect(undoInstall(result.inFlight, dataDir)).toMatchObject({ ok: false })
  })

  it('returns the failed build to the updates directory, so a retry is a rename', () => {
    // The swap *moves* the download into place, so deleting the installed
    // file on rollback threw away the only copy — and "Try again" then went
    // looking for a file the install had consumed, turning every retry into
    // another two hundred megabytes over a venue's uplink.
    const result = install()
    if (!result.ok) return
    expect(existsSync(build)).toBe(false)
    expect(undoInstall(result.inFlight, dataDir)).toEqual({ ok: true })
    expect(readFileSync(target, 'utf8')).toBe('the old box')
    expect(readFileSync(build, 'utf8')).toBe('the new box')
  })

  it('rolls back anyway when the download cannot be returned', () => {
    const result = install()
    if (!result.ok) return
    // The updates directory has gone — a tidy-up, a different disk. Getting
    // the box back on its old binary still matters more than the retry.
    rmSync(dirname(build), { recursive: true, force: true })
    expect(undoInstall(result.inFlight, dataDir)).toEqual({ ok: true })
    expect(readFileSync(target, 'utf8')).toBe('the old box')
  })

  it('keeps a note of where the download was, across a power cut', () => {
    // The marker is what a *different process* rolls back from, so a field
    // the reader drops is a field the rollback does not have.
    const result = install()
    if (!result.ok) return
    expect(readInFlight(dataDir)?.buildPath).toBe(build)
  })

  it('drops the backup once the new box has proved itself', () => {
    const result = install()
    if (!result.ok) return
    dropBackup(result.inFlight, dataDir)
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(false)
    expect(existsSync(inFlightPath(dataDir))).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('the new box')
  })
})

describe('moving a file the ordinary way will not', () => {
  /**
   * The updates directory and the binary do not have to share a filesystem.
   *
   * `/usr/local/bin/crewbox` with its data on `/home`, or on a USB stick, is
   * an ordinary layout and an EXDEV every time — so the install simply could
   * not happen, reported as a rename failure nobody would connect to the
   * cause. Run against two real filesystems rather than a faked errno,
   * because the thing being defended is what the kernel actually does.
   */
  const crossFs = (): string | null => {
    // Linux gives a tmpfs at /dev/shm that is never the same filesystem as
    // the temp dir here. Elsewhere there is no portable second one, and a
    // test that quietly proves nothing is worse than one that says so.
    try {
      const probe = join('/dev/shm', `crewbox-xdev-${process.pid}`)
      writeFileSync(probe, 'probe')
      try {
        renameSync(probe, join(dataDir, 'probe'))
        return null // same filesystem: nothing to test here
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EXDEV' ? '/dev/shm' : null
      } finally {
        rmSync(probe, { force: true })
        rmSync(join(dataDir, 'probe'), { force: true })
      }
    } catch {
      return null
    }
  }

  it('falls back to a copy when a rename crosses a filesystem', () => {
    const other = crossFs()
    if (!other) return
    const from = join(other, `crewbox-xdev-build-${process.pid}`)
    const to = join(dataDir, 'crewbox')
    writeFileSync(from, 'the new box')
    try {
      // The bare rename is what used to happen, and it is why this exists.
      expect(() => renameSync(from, to)).toThrow(/EXDEV/)
      moveFile(from, to)
      expect(readFileSync(to, 'utf8')).toBe('the new box')
      expect(existsSync(from)).toBe(false)
    } finally {
      rmSync(from, { force: true })
    }
  })

  it('passes any other rename failure straight through', () => {
    // A missing source is not something to paper over with a copy that would
    // fail the same way one line later.
    expect(() => moveFile(join(dataDir, 'nothing.bin'), join(dataDir, 'x.bin'))).toThrow()
  })
})

describe('an install nobody ever confirmed', () => {
  it('keeps a new build that is plainly running', () => {
    // Power cut after the swap, before confirmation. The box came up on the
    // new version — rolling that back would be the bug.
    const result = install()
    if (!result.ok) return
    expect(recoverInterruptedInstall(dataDir, '0.18.0')).toEqual({
      action: 'confirmed',
      toVersion: '0.18.0',
    })
    expect(readFileSync(target, 'utf8')).toBe('the new box')
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(false)
  })

  it('finishes the rollback when the old build came back up', () => {
    const result = install()
    if (!result.ok) return
    const outcome = recoverInterruptedInstall(dataDir, '0.17.1')
    expect(outcome).toMatchObject({ action: 'rolled-back', database: 'kept' })
    expect(readFileSync(target, 'utf8')).toBe('the old box')
  })

  describe('and the database the new build migrated', () => {
    /**
     * Migrations are forward-only. Putting the old binary back in front of a
     * database the new build has already migrated does not crash — it opens
     * happily, runs nothing, and serves a schema it does not understand. The
     * snapshot exists to prevent exactly that, and for the life of the
     * updater nothing ever read it back.
     */
    const dbPath = () => join(dataDir, 'crewbox.db')

    const makeDb = (userVersion: number, rows: string[]) => {
      const db = new DatabaseSync(dbPath())
      try {
        db.exec('CREATE TABLE IF NOT EXISTS notes (body TEXT)')
        db.exec(`PRAGMA user_version = ${userVersion}`)
        for (const row of rows) db.prepare('INSERT INTO notes (body) VALUES (?)').run(row)
      } finally {
        db.close()
      }
    }

    const rows = (path: string): string[] => {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        return (
          db.prepare('SELECT body FROM notes ORDER BY rowid').all() as { body: string }[]
        ).map((r) => r.body)
      } finally {
        db.close()
      }
    }

    /** Install, having taken a snapshot first, the way the service does. */
    const installWithSnapshot = () => {
      const snapshot = snapshotDb({ dbPath: dbPath(), dataDir, version: '0.17.1' })
      expect(snapshot.ok).toBe(true)
      if (!snapshot.ok) throw new Error(snapshot.reason)
      return installBuild({
        target: { kind: 'binary', path: target },
        buildPath: build,
        fromVersion: '0.17.1',
        toVersion: '0.18.0',
        dataDir,
        snapshotPath: snapshot.snapshot.path,
        now: () => 1_700_000_000_000,
      })
    }

    it('goes back with the binary', () => {
      makeDb(8, ['load in', 'doors'])
      const result = installWithSnapshot()
      if (!result.ok) return
      // The new build came up far enough to migrate, then died.
      makeDb(9, ['written by the build that then died'])

      const outcome = recoverInterruptedInstall(dataDir, '0.17.1', null, dbPath())
      expect(outcome).toMatchObject({ action: 'rolled-back', database: 'restored' })
      expect(readFileSync(target, 'utf8')).toBe('the old box')
      expect(schemaVersion(dbPath())).toBe(8)
      expect(rows(dbPath())).toEqual(['load in', 'doors'])
    })

    it('is left alone when the new build never migrated', () => {
      // The common rollback: the build would not start at all. Replacing the
      // database there would throw away every message sent since the
      // snapshot for no reason.
      makeDb(8, ['load in'])
      const result = installWithSnapshot()
      if (!result.ok) return
      makeDb(8, ['sent while the update was being attempted'])

      const outcome = recoverInterruptedInstall(dataDir, '0.17.1', null, dbPath())
      expect(outcome).toMatchObject({ action: 'rolled-back', database: 'kept' })
      expect(rows(dbPath())).toContain('sent while the update was being attempted')
    })

    it('is left alone when the caller is in no position to replace it', () => {
      // A caller that has the database open must not pass a path: on POSIX
      // the swap would look like it worked and change nothing.
      makeDb(8, ['load in'])
      const result = installWithSnapshot()
      if (!result.ok) return
      makeDb(9, [])

      const outcome = recoverInterruptedInstall(dataDir, '0.17.1')
      expect(outcome).toMatchObject({ action: 'rolled-back', database: 'kept' })
      expect(schemaVersion(dbPath())).toBe(9)
    })

    it('says so, and still puts the binary back, when the snapshot has gone', () => {
      makeDb(8, ['load in'])
      const result = installWithSnapshot()
      if (!result.ok) return
      makeDb(9, [])
      rmSync(result.inFlight.snapshotPath!, { force: true })

      const outcome = recoverInterruptedInstall(dataDir, '0.17.1', null, dbPath())
      expect(outcome).toMatchObject({ action: 'rolled-back', database: 'failed' })
      // The binary is the half that can still be fixed, so it is.
      expect(readFileSync(target, 'utf8')).toBe('the old box')
    })
  })

  it('refuses to guess when the running version is neither', () => {
    const result = install()
    if (!result.ok) return
    const outcome = recoverInterruptedInstall(dataDir, '0.16.0')
    expect(outcome).toMatchObject({ action: 'failed' })
    // Nothing touched: a box nobody can reason about is one to leave alone.
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(true)
  })

  it('does nothing at all when no install was in flight', () => {
    expect(recoverInterruptedInstall(dataDir, '0.17.1')).toEqual({ action: 'none' })
  })

  it('compares a release tag against a build version, not string against string', () => {
    // The shapes that actually occur: a marker records the tag it was asked
    // to install, and a running box reports its own build. Compared raw these
    // match neither branch, so every real interrupted install took the
    // "cannot reason about this" path and cleared the marker.
    const result = installBuild({
      target: { kind: 'binary', path: target },
      buildPath: build,
      fromVersion: '0.17.1+abc1234',
      toVersion: 'v0.18.0',
      dataDir,
      now: () => 1_700_000_000_000,
    })
    if (!result.ok) return
    expect(recoverInterruptedInstall(dataDir, '0.18.0+def5678')).toEqual({
      action: 'confirmed',
      toVersion: 'v0.18.0',
    })
  })

  it('rolls back on a tagged marker too', () => {
    const result = installBuild({
      target: { kind: 'binary', path: target },
      buildPath: build,
      fromVersion: '0.17.1+abc1234',
      toVersion: 'v0.18.0',
      dataDir,
      now: () => 1_700_000_000_000,
    })
    if (!result.ok) return
    expect(recoverInterruptedInstall(dataDir, 'v0.17.1')).toMatchObject({
      action: 'rolled-back',
    })
    expect(readFileSync(target, 'utf8')).toBe('the old box')
  })

  it('tolerates a marker that is junk', () => {
    writeFileSync(inFlightPath(dataDir), 'not json')
    expect(readInFlight(dataDir)).toBeNull()
    expect(recoverInterruptedInstall(dataDir, '0.17.1')).toEqual({ action: 'none' })
  })

  it('tolerates a marker missing the fields it needs', () => {
    writeFileSync(inFlightPath(dataDir), JSON.stringify({ toVersion: '0.18.0' }))
    expect(readInFlight(dataDir)).toBeNull()
  })

  /**
   * The case that is not an interruption at all.
   *
   * Every successful update runs this function, in the box the updater has
   * just launched, while the process that launched it is still watching. That
   * process owns the marker and the backup and is about to use one or the
   * other. A new box that helpfully "recovered" would delete the backup out
   * from under it, and a build that then failed its health probe would have
   * nothing to go back to — an unbootable box, from a working update.
   */
  describe('while another box is still supervising', () => {
    it('reports the supervisor and changes nothing', () => {
      const result = install()
      if (!result.ok) return
      expect(recoverInterruptedInstall(dataDir, '0.18.0', 4242)).toEqual({
        action: 'supervised',
        pid: 4242,
        toVersion: '0.18.0',
      })
      expect(existsSync(inFlightPath(dataDir))).toBe(true)
      expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(true)
    })

    it('leaves the backup alone even when this box is the new build', () => {
      // The exact shape of the bug: the running version matches, so without
      // the supervisor check this took the 'confirmed' branch and dropped the
      // only file a rollback can use.
      const result = install()
      if (!result.ok) return
      recoverInterruptedInstall(dataDir, '0.18.0', 4242)
      expect(existsSync(result.inFlight.backupPath)).toBe(true)
    })

    it('leaves the sweep nothing to take either', () => {
      // The marker is what stops the sweep, so leaving it in place is what
      // keeps `.old` on disk through the supervised boot.
      const result = install()
      if (!result.ok) return
      recoverInterruptedInstall(dataDir, '0.18.0', 4242)
      expect(sweepOldBinaries(dataDir, target)).toEqual([])
      expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(true)
    })

    it('still recovers normally once nobody is watching', () => {
      const result = install()
      if (!result.ok) return
      expect(recoverInterruptedInstall(dataDir, '0.18.0', null)).toMatchObject({
        action: 'confirmed',
      })
    })
  })

  it('round-trips a marker', () => {
    const marker: InFlight = {
      fromVersion: '0.17.1',
      toVersion: '0.18.0',
      kind: 'binary',
      targetPath: target,
      backupPath: `${target}${OLD_SUFFIX}`,
      snapshotPath: '/data/snapshots/crewbox-0.17.1-1.db',
      relaunch: { command: target, args: [] },
      startedAt: 1_700_000_000_000,
    }
    writeInFlight(dataDir, marker)
    expect(readInFlight(dataDir)).toEqual(marker)
    clearInFlight(dataDir)
    expect(readInFlight(dataDir)).toBeNull()
  })

  it('reads a marker written by a build that knew nothing of bundles', () => {
    // A marker outlives the build that wrote it — that is the entire point of
    // it. A box mid-rollback must not be defeated by a field its predecessor
    // did not know to write, so the older shape reads as a plain binary that
    // launches itself.
    writeFileSync(
      inFlightPath(dataDir),
      JSON.stringify({
        fromVersion: '0.17.1',
        toVersion: '0.18.0',
        targetPath: target,
        backupPath: `${target}${OLD_SUFFIX}`,
        snapshotPath: null,
        startedAt: 1_700_000_000_000,
      })
    )
    expect(readInFlight(dataDir)).toMatchObject({
      kind: 'binary',
      relaunch: { command: target, args: [] },
    })
  })
})

describe('sweeping up', () => {
  it('removes the previous binary once nothing needs it', () => {
    // Windows cannot delete its own running image, so the old one survives
    // until a later start clears it.
    writeFileSync(`${target}${OLD_SUFFIX}`, 'last week')
    expect(sweepOldBinaries(dataDir, target)).toEqual([`${target}${OLD_SUFFIX}`])
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(false)
  })

  it('will not touch the backup while an install is in flight', () => {
    // That `.old` is the only way back. Sweeping it here would turn a
    // recoverable failure into a permanent one.
    const result = install()
    if (!result.ok) return
    expect(sweepOldBinaries(dataDir, target)).toEqual([])
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(true)
  })

  it('does not mind when there is nothing to sweep', () => {
    expect(sweepOldBinaries(dataDir, target)).toEqual([])
  })
})
