import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  KEEP_SNAPSHOTS,
  clearPendingRestore,
  databaseAheadOf,
  listSnapshots,
  newestSnapshotOf,
  parseSnapshotName,
  pruneSnapshots,
  readPendingRestore,
  restoreSnapshot,
  schemaVersion,
  snapshotDb,
  snapshotName,
  snapshotsDir,
  writePendingRestore,
} from '../src/update/snapshot.ts'

/**
 * The copy taken before an install.
 *
 * The property everything rests on: what comes out is a database the old
 * build can actually open and read, not a byte-copy of a file that was being
 * written at the time. So these tests write real rows through a real
 * connection and read them back out of the snapshot.
 */

let dir: string
let dbPath: string

const seed = (rows: string[], userVersion = 0) => {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`PRAGMA user_version = ${userVersion}`)
  db.exec('CREATE TABLE IF NOT EXISTS notes (body TEXT)')
  for (const row of rows) db.prepare('INSERT INTO notes (body) VALUES (?)').run(row)
  return db
}

/** What an install does to the database: run the new build's migrations. */
const migrateTo = (userVersion: number, rows: string[] = []) => {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`PRAGMA user_version = ${userVersion}`)
    for (const row of rows) db.prepare('INSERT INTO notes (body) VALUES (?)').run(row)
  } finally {
    db.close()
  }
}

const readBack = (path: string): string[] => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (db.prepare('SELECT body FROM notes ORDER BY rowid').all() as { body: string }[]).map(
      (r) => r.body
    )
  } finally {
    db.close()
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-snap-'))
  dbPath = join(dir, 'crewbox.db')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('taking one', () => {
  it('captures what the database holds', () => {
    const db = seed(['load in', 'doors'])
    try {
      const result = snapshotDb({
        dbPath,
        dataDir: dir,
        version: '0.17.1',
        now: () => 1_700_000_000_000,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(readBack(result.snapshot.path)).toEqual(['load in', 'doors'])
    } finally {
      db.close()
    }
  })

  it('is safe while the box is still writing', () => {
    // The reason for VACUUM INTO over a file copy: in WAL mode the newest
    // rows live in the -wal file, and a plain copy of crewbox.db alone would
    // silently lose every write since the last checkpoint.
    const db = seed(['before'])
    try {
      db.prepare('INSERT INTO notes (body) VALUES (?)').run('uncheckpointed')
      const result = snapshotDb({ dbPath, dataDir: dir, version: '0.17.1' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(readBack(result.snapshot.path)).toContain('uncheckpointed')
    } finally {
      db.close()
    }
  })

  it('produces one self-contained file, with no -wal beside it', () => {
    // A restore is somebody copying one file back. Two files is a way to
    // restore half a database.
    const db = seed(['a'])
    try {
      snapshotDb({ dbPath, dataDir: dir, version: '0.17.1' })
      expect(readdirSync(snapshotsDir(dir)).filter((n) => n.endsWith('-wal'))).toEqual([])
      expect(readdirSync(snapshotsDir(dir)).length).toBe(1)
    } finally {
      db.close()
    }
  })

  it('says why rather than throwing when there is no database', () => {
    const result = snapshotDb({ dbPath: join(dir, 'absent.db'), dataDir: dir, version: '0.17.1' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('could not')
  })

  it('refuses to overwrite a snapshot rather than replacing it', () => {
    // VACUUM INTO will not clobber, which is what we want: the file it would
    // have replaced may be the one somebody is about to restore.
    const db = seed(['a'])
    try {
      const first = snapshotDb({
        dbPath,
        dataDir: dir,
        version: '0.17.1',
        now: () => 1_700_000_000_000,
      })
      expect(first.ok).toBe(true)
      const again = snapshotDb({
        dbPath,
        dataDir: dir,
        version: '0.17.1',
        now: () => 1_700_000_000_000,
      })
      expect(again.ok).toBe(false)
    } finally {
      db.close()
    }
  })
})

describe('names', () => {
  it('round-trip the version and the time', () => {
    const name = snapshotName('0.17.1', 1_700_000_000_000)
    expect(parseSnapshotName(name)).toEqual({ version: '0.17.1', takenAt: 1_700_000_000_000 })
  })

  it('survive a version with dashes in it', () => {
    const name = snapshotName('0.18.0-rc.1', 1_700_000_000_000)
    expect(parseSnapshotName(name)).toEqual({ version: '0.18.0-rc.1', takenAt: 1_700_000_000_000 })
  })

  it('ignore files that are not ours', () => {
    expect(parseSnapshotName('crewbox.db')).toBeNull()
    expect(parseSnapshotName('notes.txt')).toBeNull()
  })
})

describe('keeping the disk in check', () => {
  const fake = (version: string, at: number) => {
    writeFileSync(join(snapshotsDir(dir), snapshotName(version, at)), 'not really a database')
  }

  beforeEach(() => {
    const db = seed(['a'])
    db.close()
    snapshotDb({ dbPath, dataDir: dir, version: '0.1.0', now: () => 1_000_000_000_000 })
  })

  it('lists newest first', () => {
    fake('0.2.0', 1_000_000_002_000)
    fake('0.3.0', 1_000_000_003_000)
    expect(listSnapshots(dir).map((s) => s.version)).toEqual(['0.3.0', '0.2.0', '0.1.0'])
  })

  it('keeps the newest few and drops the rest', () => {
    for (let i = 1; i <= 6; i++) fake(`0.${i}.9`, 1_000_000_000_000 + i * 1000)
    const removed = pruneSnapshots(dir, KEEP_SNAPSHOTS)
    expect(listSnapshots(dir).length).toBe(KEEP_SNAPSHOTS)
    expect(removed.length).toBe(4)
    // The three kept are the three newest.
    expect(listSnapshots(dir).map((s) => s.version)).toEqual(['0.6.9', '0.5.9', '0.4.9'])
  })

  it('finds the newest snapshot of one version', () => {
    fake('0.1.0', 1_000_000_005_000)
    fake('0.2.0', 1_000_000_009_000)
    expect(newestSnapshotOf(dir, '0.1.0')?.takenAt).toBe(1_000_000_005_000)
    expect(newestSnapshotOf(dir, '9.9.9')).toBeNull()
  })

  it('does not mind a box that has never taken one', () => {
    const empty = mkdtempSync(join(tmpdir(), 'crewbox-empty-'))
    try {
      expect(listSnapshots(empty)).toEqual([])
      expect(() => pruneSnapshots(empty)).not.toThrow()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('never pruning the one just taken', () => {
  it('keeps it even when the clock has gone backwards', () => {
    // A box in a flight case has no battery-backed clock: it boots at some
    // default, gets a network, and the time jumps — which is as likely to be
    // backwards as forwards. The snapshot taken a second before an install
    // then sorts behind last week's three and is deleted on the very next
    // line, leaving the marker pointing at a file that is not there and the
    // rollback with nothing to restore.
    const db = seed(['a'])
    db.close()
    const fresh = snapshotDb({ dbPath, dataDir: dir, version: '0.17.1', now: () => 1_000_000_000 })
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) return
    for (let i = 1; i <= 3; i++) {
      writeFileSync(
        join(snapshotsDir(dir), snapshotName(`0.${i}.0`, 1_800_000_000_000 + i * 1000)),
        'from after the clock jumped'
      )
    }

    // Without the guard this is exactly the file that goes.
    expect(listSnapshots(dir)[3]?.path).toBe(fresh.snapshot.path)
    const removed = pruneSnapshots(dir, KEEP_SNAPSHOTS, fresh.snapshot.path)
    expect(removed).toEqual([])
    expect(listSnapshots(dir).map((s) => s.path)).toContain(fresh.snapshot.path)
  })

  it('still prunes around it', () => {
    const db = seed(['a'])
    db.close()
    const fresh = snapshotDb({ dbPath, dataDir: dir, version: '0.17.1', now: () => 1_000_000_000 })
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) return
    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(snapshotsDir(dir), snapshotName(`0.${i}.0`, 1_800_000_000_000 + i * 1000)),
        'older'
      )
    }
    pruneSnapshots(dir, 2, fresh.snapshot.path)
    // Two of the others, plus the protected one.
    expect(listSnapshots(dir).length).toBe(3)
    expect(listSnapshots(dir).map((s) => s.path)).toContain(fresh.snapshot.path)
  })
})

describe('putting the database back', () => {
  /**
   * The half of the rollback that was never written. A snapshot was taken
   * before every install and its path carried in the in-flight marker, and
   * nothing ever read it — so a rollback restored the binary and left the
   * database exactly as the new build had migrated it. Which is the precise
   * situation the snapshot exists to prevent: forward-only migrations mean
   * the old build opens happily, runs nothing, and serves a schema it does
   * not understand.
   */

  const snapshotAt = (version: string) => {
    const result = snapshotDb({ dbPath, dataDir: dir, version })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    return result.snapshot.path
  }

  it('reads the schema number off a file', () => {
    const db = seed(['a'], 8)
    db.close()
    expect(schemaVersion(dbPath)).toBe(8)
    expect(schemaVersion(join(dir, 'absent.db'))).toBeNull()
  })

  it('restores when the failed build had already migrated', () => {
    const db = seed(['load in', 'doors'], 8)
    db.close()
    const snapshot = snapshotAt('0.17.1')
    migrateTo(9, ['written by the build that then died'])

    expect(databaseAheadOf(dbPath, snapshot)).toBe(true)
    const result = restoreSnapshot({ dbPath, snapshotPath: snapshot, now: () => 1_700_000_000_000 })
    expect(result.ok).toBe(true)
    if (!result.ok || !result.restored) throw new Error('expected a restore')

    expect(schemaVersion(dbPath)).toBe(8)
    expect(readBack(dbPath)).toEqual(['load in', 'doors'])
    // Nothing is deleted: whatever the new build wrote is somebody's show.
    expect(readBack(result.supersededPath)).toContain('written by the build that then died')
  })

  it('leaves a database the failed build never migrated alone', () => {
    // Most rollbacks are of a build that never got as far as opening it, and
    // replacing the file there would throw away every message sent since the
    // snapshot for no reason at all.
    const db = seed(['load in'], 8)
    db.close()
    const snapshot = snapshotAt('0.17.1')
    migrateTo(8, ['sent while the update was being attempted'])

    expect(databaseAheadOf(dbPath, snapshot)).toBe(false)
    const result = restoreSnapshot({ dbPath, snapshotPath: snapshot })
    expect(result).toEqual({
      ok: true,
      restored: false,
      reason: 'the database was never migrated past this build',
    })
    expect(readBack(dbPath)).toContain('sent while the update was being attempted')
  })

  it('takes the -wal and -shm with it, so nothing is replayed onto the restore', () => {
    // SQLite derives the journal names from the database name. A stale -wal
    // left beside the restored file is replayed into it on the next open,
    // which would put the migration straight back.
    const db = seed(['load in'], 8)
    db.close()
    const snapshot = snapshotAt('0.17.1')
    const live = new DatabaseSync(dbPath)
    live.exec('PRAGMA journal_mode = WAL')
    live.exec('PRAGMA user_version = 9')
    live.prepare('INSERT INTO notes (body) VALUES (?)').run('in the wal')
    live.close()

    const result = restoreSnapshot({ dbPath, snapshotPath: snapshot, now: () => 1_700_000_000_000 })
    expect(result.ok).toBe(true)
    if (!result.ok || !result.restored) throw new Error('expected a restore')
    expect(readdirSync(dir).filter((n) => n === 'crewbox.db-wal')).toEqual([])
    expect(schemaVersion(dbPath)).toBe(8)
    expect(readBack(dbPath)).toEqual(['load in'])
  })

  it('says why rather than throwing when the snapshot has gone', () => {
    const db = seed(['a'], 8)
    db.close()
    const result = restoreSnapshot({ dbPath, snapshotPath: join(dir, 'snapshots', 'gone.db') })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('to restore from')
  })

  it('treats a database that will not open as one needing the restore', () => {
    const db = seed(['load in'], 8)
    db.close()
    const snapshot = snapshotAt('0.17.1')
    writeFileSync(dbPath, 'this is not a database')
    expect(databaseAheadOf(dbPath, snapshot)).toBe(true)
    const result = restoreSnapshot({ dbPath, snapshotPath: snapshot })
    expect(result.ok).toBe(true)
    if (!result.ok || !result.restored) throw new Error('expected a restore')
    expect(readBack(dbPath)).toEqual(['load in'])
  })
})

describe('a restore the running box could not do itself', () => {
  /**
   * The in-process rollback will not touch the database — crew are typing
   * into it and this process has it open — so it writes the debt down and
   * the next start, which runs before anything opens it, pays it.
   */
  it('round-trips the note', () => {
    expect(readPendingRestore(dir)).toBeNull()
    const pending = {
      snapshotPath: join(dir, 'snapshots', 'crewbox-0.17.1-1.db'),
      fromVersion: '0.17.1',
      toVersion: '0.18.0',
      at: 1_700_000_000_000,
    }
    expect(writePendingRestore(dir, pending)).toBe(true)
    expect(readPendingRestore(dir)).toEqual(pending)
    clearPendingRestore(dir)
    expect(readPendingRestore(dir)).toBeNull()
  })

  it('refuses to act on junk', () => {
    writeFileSync(join(dir, 'restore-db.json'), 'not json at all')
    expect(readPendingRestore(dir)).toBeNull()
    writeFileSync(join(dir, 'restore-db.json'), JSON.stringify({ snapshotPath: 42 }))
    expect(readPendingRestore(dir)).toBeNull()
  })
})
