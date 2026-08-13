import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  KEEP_SNAPSHOTS,
  listSnapshots,
  newestSnapshotOf,
  parseSnapshotName,
  pruneSnapshots,
  snapshotDb,
  snapshotName,
  snapshotsDir,
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

const seed = (rows: string[]) => {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE IF NOT EXISTS notes (body TEXT)')
  for (const row of rows) db.prepare('INSERT INTO notes (body) VALUES (?)').run(row)
  return db
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
