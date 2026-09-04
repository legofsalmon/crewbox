import {
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
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * A copy of the database taken immediately before an install.
 *
 * **Migrations are forward-only.** `openDb` walks `PRAGMA user_version` up to
 * the number of migrations the running build carries, and there is no way
 * back down — by design, because a down-migration that drops a column is a
 * down-migration that loses what somebody typed. That is fine until the day a
 * new build has to be undone: put v0.17 back in front of a database v0.18 has
 * already migrated and it does not crash, which would at least be honest. It
 * opens happily, sees a `user_version` higher than it knows about, runs no
 * migrations, and serves a schema it does not understand. Missing columns,
 * absent tables, and a crew wondering why the show log is empty.
 *
 * So the rollback path cannot be "put the old binary back" on its own. It has
 * to be "put the old binary back beside the database it was last known to
 * work with", and that means a copy taken before anything changed.
 *
 * `VACUUM INTO` rather than a file copy: it is safe on a running database in
 * WAL mode, and produces one self-contained file with no `-wal` or `-shm`
 * beside it to forget. Exactly what `deploy/snapshot-db.mjs` does for the
 * spare-box swap, for exactly the same reason.
 */

/** Under the data dir, so a wipe takes the snapshots with it. */
export const SNAPSHOTS_DIR = 'snapshots'

/**
 * How many to keep.
 *
 * A festival box's database is small — megabytes, not gigabytes — but it sits
 * on whatever disk the box has, which on a mini PC in a flight case is not
 * generous. Three is enough to undo an update, undo the update before it, and
 * still have the one from before that; more than that and nobody is going
 * back by hand anyway, they are restoring from `deploy/backup.sh`.
 */
export const KEEP_SNAPSHOTS = 3

export interface Snapshot {
  /** Absolute path to the file. */
  path: string
  name: string
  /** The version that was running when it was taken — what it belongs to. */
  version: string
  /** Epoch ms, from the filename rather than the filesystem. */
  takenAt: number
  bytes: number
}

/** Where snapshots live for a given data directory. */
export function snapshotsDir(dataDir: string): string {
  return join(dataDir, SNAPSHOTS_DIR)
}

/**
 * The filename carries both facts a person needs when picking one by hand in
 * a hurry: which version it belongs to, and when it was taken. Neither is
 * recoverable from the file's contents, and mtime is the first thing a copy
 * between disks destroys.
 */
export function snapshotName(version: string, at: number): string {
  return `crewbox-${version}-${at}.db`
}

const NAME_PATTERN = /^crewbox-(.+)-(\d{10,})\.db$/

/** Parse a snapshot filename, or null when it is not one of ours. */
export function parseSnapshotName(name: string): { version: string; takenAt: number } | null {
  const match = NAME_PATTERN.exec(name)
  if (!match) return null
  const takenAt = Number(match[2])
  if (!Number.isFinite(takenAt)) return null
  return { version: match[1]!, takenAt }
}

export type SnapshotResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: string }

/**
 * Copy the live database, before anything is allowed to change it.
 *
 * Never throws. A snapshot that cannot be taken is a reason to stop the
 * install and say why, not an exception three frames up: the caller's next
 * decision — refuse to install — depends on this answer, so it is a value.
 */
export function snapshotDb(options: {
  dbPath: string
  dataDir: string
  /** The version being left behind. This snapshot belongs to that build. */
  version: string
  now?: () => number
}): SnapshotResult {
  const at = (options.now ?? Date.now)()
  const dir = snapshotsDir(options.dataDir)
  const name = snapshotName(options.version, at)
  const dest = join(dir, name)

  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    return { ok: false, reason: `could not create ${dir}: ${reason(err)}` }
  }

  let db: DatabaseSync
  try {
    db = new DatabaseSync(options.dbPath, { readOnly: true })
  } catch (err) {
    return { ok: false, reason: `could not open the database: ${reason(err)}` }
  }
  try {
    // SQLite reads a double-quoted token as an identifier, so the destination
    // has to be a single-quoted string literal with any embedded quote
    // doubled. A data directory with an apostrophe in it is unusual and
    // entirely legal.
    db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`)
  } catch (err) {
    // VACUUM INTO refuses to overwrite, so a collision lands here rather than
    // silently replacing a snapshot somebody may be about to restore.
    return { ok: false, reason: `could not write the snapshot: ${reason(err)}` }
  } finally {
    db.close()
  }

  let bytes = 0
  try {
    bytes = statSync(dest).size
  } catch {
    // Written but unstattable is strange enough to report as a size of zero
    // rather than to fail — the file is there, which is the thing that counts.
  }
  return { ok: true, snapshot: { path: dest, name, version: options.version, takenAt: at, bytes } }
}

/**
 * The schema number a database file is at, or null when it cannot be read.
 *
 * `PRAGMA user_version` is the whole of the migration bookkeeping — `openDb`
 * walks it up and never down — so it is also the only way to ask the question
 * that matters on a rollback: has a newer build already been here?
 */
export function schemaVersion(path: string): number | null {
  if (!existsSync(path)) return null
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    return typeof row?.user_version === 'number' ? row.user_version : null
  } catch {
    return null
  } finally {
    db.close()
  }
}

/**
 * Has the live database been migrated past the build this snapshot belongs to?
 *
 * Null when the question cannot be answered — an unreadable snapshot is not
 * evidence either way, and guessing here would either throw away a database
 * or leave an old build in front of one it cannot read.
 */
export function databaseAheadOf(dbPath: string, snapshotPath: string): boolean | null {
  const snapshot = schemaVersion(snapshotPath)
  if (snapshot === null) return null
  const live = schemaVersion(dbPath)
  // A database that will not open at all is not one the old build can serve,
  // and the snapshot is a known-good copy of it. Treat it as needing the
  // restore — nothing is deleted either way.
  if (live === null) return true
  return live > snapshot
}

export type RestoreResult =
  /** Nothing to do: the old build can read what is there. */
  | { ok: true; restored: false; reason: string }
  /** The live database was put aside and the snapshot put in its place. */
  | { ok: true; restored: true; supersededPath: string }
  | { ok: false; reason: string }

/**
 * Put the database back beside the binary that is going back.
 *
 * This is the half of the rollback that was never written. A snapshot was
 * taken before every install and its path carried in the in-flight marker,
 * and nothing ever read it — so a rollback restored the binary and left the
 * database exactly as the new build had migrated it, which is the precise
 * situation the snapshot exists to prevent: v0.17 in front of a schema v0.18
 * wrote, opening happily, running no migrations, and serving tables it does
 * not understand.
 *
 * Two things it deliberately does not do:
 *
 *  - **Restore unconditionally.** Most rollbacks are of a build that never
 *    got as far as opening the database, and replacing it there would throw
 *    away every message sent since the snapshot for no reason at all. The
 *    schema number is the test: only a database a newer build has actually
 *    migrated is one the old build cannot read.
 *  - **Delete anything.** The superseded database is moved aside, `-wal` and
 *    `-shm` with it so the set stays openable, and left there. Whatever the
 *    new build wrote before it failed is somebody's show, and this is a
 *    process that runs unattended at four in the morning.
 *
 * Must be called before the database is opened. On POSIX a process holding an
 * open handle keeps writing to the file this replaces, which would be a
 * rollback that looked like it worked and changed nothing.
 */
export function restoreSnapshot(options: {
  dbPath: string
  snapshotPath: string
  now?: () => number
}): RestoreResult {
  const { dbPath, snapshotPath } = options
  if (!existsSync(snapshotPath)) {
    return { ok: false, reason: `there is no ${snapshotPath} to restore from` }
  }
  const ahead = databaseAheadOf(dbPath, snapshotPath)
  if (ahead === null) {
    return { ok: false, reason: `could not read the schema version of ${snapshotPath}` }
  }
  if (!ahead) {
    return { ok: true, restored: false, reason: 'the database was never migrated past this build' }
  }

  const at = (options.now ?? Date.now)()
  const superseded = `${dbPath}.superseded-${at}`
  try {
    if (existsSync(dbPath)) renameSync(dbPath, superseded)
    // SQLite derives the journal names from the database name, so the sidecars
    // move under the new name rather than being deleted: the superseded set
    // stays openable, and — the part that matters here — no stale `-wal` is
    // left beside `dbPath` for SQLite to replay onto the restored file.
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) {
        renameSync(`${dbPath}${suffix}`, `${superseded}${suffix}`)
      }
    }
  } catch (err) {
    return { ok: false, reason: `could not move the migrated database aside: ${reason(err)}` }
  }

  try {
    // A copy, not a move: the snapshot stays in the rotation, because a
    // rollback that fails to start is a box that needs to try again.
    copyFileSync(snapshotPath, dbPath)
  } catch (err) {
    // Put back what was there. An old build in front of a new schema is bad;
    // a box with no database at all is worse.
    try {
      renameSync(superseded, dbPath)
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${superseded}${suffix}`)) {
          renameSync(`${superseded}${suffix}`, `${dbPath}${suffix}`)
        }
      }
    } catch {
      return {
        ok: false,
        reason: `could not restore the database, and could not put the migrated one back — it is at ${superseded}`,
      }
    }
    return { ok: false, reason: `could not copy the snapshot into place: ${reason(err)}` }
  }

  return { ok: true, restored: true, supersededPath: superseded }
}

/**
 * A database restore that is owed but cannot be done yet.
 *
 * The rollback that happens in the *running* box — the new build would not
 * come up, so the old process puts the binary back and starts answering again
 * — deliberately will not touch the database: crew are typing into it, and
 * this process has it open, so replacing the file underneath would take the
 * messages of whoever is on shift and, on POSIX, not even change what this
 * process goes on writing to.
 *
 * But leaving it is not an answer either. A forward-only migration the new
 * build ran is still in there, and the old build in front of it does not
 * crash — it serves a schema it does not understand. So the debt is written
 * down, the operator is told the box needs a restart, and the next start —
 * which happens before anything opens the database — pays it.
 */
export const PENDING_RESTORE_FILE = 'restore-db.json'

export interface PendingRestore {
  snapshotPath: string
  /** The build the snapshot belongs to. Only that build may be restored to. */
  fromVersion: string
  /** The build whose migrations are in the live database. */
  toVersion: string
  at: number
}

export function pendingRestorePath(dataDir: string): string {
  return join(dataDir, PENDING_RESTORE_FILE)
}

/** Never throws: an unwritable note is not worth failing a rollback over. */
export function writePendingRestore(dataDir: string, pending: PendingRestore): boolean {
  try {
    writeFileSync(pendingRestorePath(dataDir), JSON.stringify(pending, null, 2))
    return true
  } catch {
    return false
  }
}

/** The owed restore, or null. Tolerates any junk in the file. */
export function readPendingRestore(dataDir: string): PendingRestore | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(pendingRestorePath(dataDir), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Partial<PendingRestore>
    if (
      typeof r.snapshotPath !== 'string' ||
      typeof r.fromVersion !== 'string' ||
      typeof r.toVersion !== 'string' ||
      typeof r.at !== 'number'
    ) {
      return null
    }
    return {
      snapshotPath: r.snapshotPath,
      fromVersion: r.fromVersion,
      toVersion: r.toVersion,
      at: r.at,
    }
  } catch {
    return null
  }
}

export function clearPendingRestore(dataDir: string): void {
  try {
    rmSync(pendingRestorePath(dataDir), { force: true })
  } catch {
    // It will be read again next start and found to be a no-op.
  }
}

/** Every snapshot on this box, newest first. */
export function listSnapshots(dataDir: string): Snapshot[] {
  const dir = snapshotsDir(dataDir)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: Snapshot[] = []
  for (const name of names) {
    const parsed = parseSnapshotName(name)
    if (!parsed) continue
    const path = join(dir, name)
    let bytes: number
    try {
      bytes = statSync(path).size
    } catch {
      continue
    }
    out.push({ path, name, version: parsed.version, takenAt: parsed.takenAt, bytes })
  }
  return out.sort((a, b) => b.takenAt - a.takenAt)
}

/**
 * Drop all but the newest `keep`.
 *
 * Returns what it removed, because a box quietly deleting the thing that
 * would have got somebody out of trouble should at least say so in a log.
 *
 * `protect` is never deleted, whatever the ordering says. "Newest" is read
 * from the timestamp in the filename, and a box in a flight case has no
 * battery-backed clock: it boots at some default, gets a network, and the
 * time jumps — backwards as readily as forwards. A snapshot taken a second
 * before an install can therefore sort *behind* three from last week and be
 * deleted on the very next line, leaving the install with a marker pointing
 * at a file that is not there and a rollback with nothing to restore. The
 * caller always knows which one it just took.
 */
export function pruneSnapshots(
  dataDir: string,
  keep: number = KEEP_SNAPSHOTS,
  protect?: string
): string[] {
  const removed: string[] = []
  const keeping = listSnapshots(dataDir).filter((s) => s.path !== protect)
  for (const snapshot of keeping.slice(Math.max(keep, 0))) {
    try {
      rmSync(snapshot.path, { force: true })
      removed.push(snapshot.name)
    } catch {
      // A snapshot that will not delete is not worth failing an update over.
    }
  }
  return removed
}

/** The newest snapshot taken of a given version, or null. */
export function newestSnapshotOf(dataDir: string, version: string): Snapshot | null {
  return listSnapshots(dataDir).find((s) => s.version === version) ?? null
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
