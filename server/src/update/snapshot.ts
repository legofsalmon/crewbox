import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
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
 */
export function pruneSnapshots(dataDir: string, keep: number = KEEP_SNAPSHOTS): string[] {
  const removed: string[] = []
  for (const snapshot of listSnapshots(dataDir).slice(Math.max(keep, 0))) {
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
