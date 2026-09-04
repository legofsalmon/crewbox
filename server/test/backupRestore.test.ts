import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `deploy/backup.sh` and `deploy/restore.sh`, run for real.
 *
 * These two scripts are the whole disaster plan: they are what stands
 * between a dead box on the Saturday and a festival with no comms. They are
 * also the code nobody runs until the night it matters, which is the worst
 * possible time to find out that the newest directory on the stick holds
 * half a database.
 *
 * So this runs bash, on real files, in a temporary directory — because a
 * unit test of a shell script that does not execute the shell script is a
 * test of a paraphrase.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'crewbox-backup-'))
  dirs.push(dir)
  return dir
}

/** A data directory holding a database a restore would actually want. */
function makeBox(root: string, opts: { apk?: boolean; cert?: boolean } = {}): string {
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'crewbox.db'))
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)')
  db.exec('CREATE TABLE channels (id TEXT PRIMARY KEY)')
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, body TEXT)')
  db.exec("INSERT INTO users VALUES ('u1', 'Colm')")
  db.exec('PRAGMA user_version = 10')
  db.close()
  mkdirSync(join(dataDir, 'files'), { recursive: true })
  writeFileSync(join(dataDir, 'files', 'stage-plot.jpg'), 'not really a jpeg')
  if (opts.apk !== false) writeFileSync(join(dataDir, 'crewbox-v0.18.0.apk'), 'PK apk')
  if (opts.cert) {
    writeFileSync(join(dataDir, 'cert.pem'), '-----BEGIN CERTIFICATE-----\n')
    writeFileSync(join(dataDir, 'key.pem'), '-----BEGIN PRIVATE KEY-----\n')
  }
  return dataDir
}

const script = (name: string): string => join(import.meta.dirname, '..', '..', 'deploy', name)

interface Run {
  status: number
  stdout: string
  stderr: string
}

function run(name: string, args: string[], env: Record<string, string>): Run {
  // spawnSync rather than execFileSync, because these scripts say the useful
  // half of what they know on stderr — which backup they passed over, and
  // why — and that is worth asserting on a run that succeeded.
  const result = spawnSync('bash', [script(name), ...args], {
    encoding: 'utf8',
    // A restore refuses to run under a live box, and probes the port to find
    // out. Nothing is listening here; point it at one that will stay that
    // way rather than at whatever a developer has running on 8787.
    env: { ...process.env, CREWBOX_PORT: '59999', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const listing = (dir: string): string[] =>
  execFileSync('bash', ['-c', `ls -1 ${JSON.stringify(dir)} 2>/dev/null || true`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .sort()

describe('taking a backup', () => {
  it('carries the database, the uploads, the certificate and the Android app', () => {
    const root = scratch()
    const dataDir = makeBox(root, { cert: true })
    const backupDir = join(root, 'backups')

    const result = run('backup.sh', [], { DATA_DIR: dataDir, BACKUP_DIR: backupDir })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)

    const [stamp] = listing(backupDir)
    expect(stamp).toMatch(/^\d{8}-\d{6}$/)
    const dest = join(backupDir, stamp)
    expect(listing(dest)).toEqual([
      'MANIFEST.txt',
      'cert.pem',
      'crewbox-v0.18.0.apk',
      'crewbox.db',
      'files',
      'key.pem',
    ])

    // The APK is the one the runbook tells you to drop in the data
    // directory and the one the printed poster's QR points at. It was not
    // backed up at all, so a spare restored from a stick answered the
    // poster on the wall with a 404 — on the morning a crew had just
    // switched boxes, with no internet and no Android SDK to rebuild it.
    expect(readFileSync(join(dest, 'crewbox-v0.18.0.apk'), 'utf8')).toContain('apk')
    const manifest = readFileSync(join(dest, 'MANIFEST.txt'), 'utf8')
    expect(manifest).toMatch(/^apk: +1 file\(s\)$/m)
    expect(manifest).toMatch(/^tls: +included$/m)
    expect(manifest).toMatch(/^uploads: +1$/m)
  })

  it('says so in the manifest when there is no APK to carry', () => {
    const root = scratch()
    const dataDir = makeBox(root, { apk: false })
    const backupDir = join(root, 'backups')
    run('backup.sh', [], { DATA_DIR: dataDir, BACKUP_DIR: backupDir })
    const [stamp] = listing(backupDir)
    expect(readFileSync(join(backupDir, stamp, 'MANIFEST.txt'), 'utf8')).toMatch(
      /^apk: +NOT PRESENT/m
    )
  })

  it('leaves nothing wearing a finished backup name when it fails partway', () => {
    // The failure this reproduces: the stick is pulled, or the disk fills,
    // after the working directory is made and before the manifest is
    // written. The old script wrote straight into the timestamped
    // directory, so what was left behind was the newest backup on the
    // stick, holding half a database — the one directory nobody would
    // question at 3am.
    //
    // Forced here by making the snapshot step refuse, where a full disk
    // would. Both tools, because the script prefers sqlite3 and falls back
    // to node: sabotaging only one passes or fails depending on what the
    // machine running the tests happens to have installed, which is how
    // this passed here and failed on CI.
    const root = scratch()
    const dataDir = makeBox(root)
    const backupDir = join(root, 'backups')
    mkdirSync(backupDir, { recursive: true })

    const bin = join(root, 'bin')
    mkdirSync(bin)
    for (const tool of ['sqlite3', 'node']) {
      writeFileSync(join(bin, tool), '#!/bin/sh\nexit 1\n')
      chmodSync(join(bin, tool), 0o755)
    }

    const result = run('backup.sh', [], {
      DATA_DIR: dataDir,
      BACKUP_DIR: backupDir,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    })
    expect(result.status).not.toBe(0)
    // Not a partial, not a stamped directory: nothing at all.
    expect(listing(backupDir)).toEqual([])
  })

  it('keeps the newest N and sweeps a partial an earlier run left behind', () => {
    const root = scratch()
    const dataDir = makeBox(root)
    const backupDir = join(root, 'backups')
    mkdirSync(backupDir, { recursive: true })
    // Older than anything this run will write, and lexically sorted, which
    // is what the retention now relies on rather than `ls -t`.
    for (const stamp of ['20260101-000000', '20260102-000000', '20260103-000000']) {
      mkdirSync(join(backupDir, stamp))
      writeFileSync(join(backupDir, stamp, 'crewbox.db'), 'old')
    }
    // A directory with a space in its name: the old `ls -1dt | xargs` split
    // this into two arguments and removed neither.
    mkdirSync(join(backupDir, 'not a backup'))
    mkdirSync(join(backupDir, '20251231-235959.partial'))

    run('backup.sh', [], { DATA_DIR: dataDir, BACKUP_DIR: backupDir, BACKUP_KEEP: '2' })

    const left = listing(backupDir)
    // Two of the three old ones dropped, this run's kept, the abandoned
    // partial swept, and anything that is not ours left strictly alone.
    expect(left).toContain('20260103-000000')
    expect(left).toContain('not a backup')
    expect(left).not.toContain('20260101-000000')
    expect(left).not.toContain('20251231-235959.partial')
    expect(left.filter((n) => /^\d{8}-\d{6}$/.test(n))).toHaveLength(2)
  })

  it('records the time on the box, for the admin panel to read back', () => {
    const root = scratch()
    const dataDir = makeBox(root)
    const backupDir = join(root, 'backups')
    run('backup.sh', [], { DATA_DIR: dataDir, BACKUP_DIR: backupDir })
    const mark = JSON.parse(readFileSync(join(dataDir, 'last-backup.json'), 'utf8')) as {
      at: number
      dest: string
    }
    expect(mark.at).toBeGreaterThan(1_700_000_000_000)
    expect(mark.dest.startsWith(backupDir)).toBe(true)
    // The marker names the finished backup, never the partial it was
    // written through.
    expect(mark.dest).not.toContain('.partial')
  })
})

describe('restoring one', () => {
  const roundTrip = (opts: { cert?: boolean } = {}) => {
    const root = scratch()
    const dataDir = makeBox(root, opts)
    const backupDir = join(root, 'backups')
    run('backup.sh', [], { DATA_DIR: dataDir, BACKUP_DIR: backupDir })
    return { root, dataDir, backupDir, spare: join(root, 'spare') }
  }

  it('puts a whole box back on a spare machine', () => {
    const { backupDir, spare } = roundTrip({ cert: true })
    const result = run('restore.sh', [], { DATA_DIR: spare, BACKUP_DIR: backupDir })
    expect(result.status).toBe(0)

    const db = new DatabaseSync(join(spare, 'crewbox.db'), { readOnly: true })
    expect(db.prepare('SELECT name FROM users').all()).toEqual([{ name: 'Colm' }])
    db.close()
    expect(listing(spare)).toContain('crewbox-v0.18.0.apk')
    expect(listing(join(spare, 'files'))).toEqual(['stage-plot.jpg'])
    expect(listing(spare)).toContain('cert.pem')
  })

  it('warns when the backup carried no app, because the poster QR will 404', () => {
    const root = scratch()
    const dataDir = makeBox(root, { apk: false })
    const backupDir = join(root, 'backups')
    run('backup.sh', [], { DATA_DIR: dataDir, BACKUP_DIR: backupDir })
    const result = run('restore.sh', [], { DATA_DIR: join(root, 'spare'), BACKUP_DIR: backupDir })
    expect(result.stdout).toContain('no Android app in that backup')
  })

  it('passes over an unfinished backup for the newest one that finished', () => {
    // The whole point of the `.partial` name. Left as a bare timestamped
    // directory — which is what an interrupted run of the *old* script
    // produced, and what is sitting on sticks in the field right now — it
    // has no manifest, so it is passed over rather than restored.
    const { backupDir, spare } = roundTrip()
    const good = listing(backupDir)[0]
    const newer = join(backupDir, '29991231-235959')
    mkdirSync(newer)
    writeFileSync(join(newer, 'crewbox.db'), 'half a database')

    const result = run('restore.sh', [], { DATA_DIR: spare, BACKUP_DIR: backupDir })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('skipping 29991231-235959')
    expect(result.stdout).toContain(join(backupDir, good))

    const db = new DatabaseSync(join(spare, 'crewbox.db'), { readOnly: true })
    expect(db.prepare('SELECT name FROM users').all()).toEqual([{ name: 'Colm' }])
    db.close()
  })

  it('passes over a finished-looking backup whose database does not read', () => {
    // A stick pulled mid-write leaves a file SQLite opens quite happily: it
    // only notices the missing pages when something reads them, which on a
    // box is ten minutes into the show.
    const { backupDir, spare } = roundTrip()
    const good = listing(backupDir)[0]
    const newer = join(backupDir, '29991231-235959')
    mkdirSync(newer)
    const sound = readFileSync(join(backupDir, good, 'crewbox.db'))
    writeFileSync(join(newer, 'crewbox.db'), sound.subarray(0, Math.floor(sound.length / 2)))
    writeFileSync(join(newer, 'MANIFEST.txt'), 'taken: whenever\n')

    const result = run('restore.sh', [], { DATA_DIR: spare, BACKUP_DIR: backupDir })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('its database does not read')
    expect(result.stdout).toContain(join(backupDir, good))
  })

  it('refuses a directory named by hand that never finished', () => {
    const { root, backupDir, spare } = roundTrip()
    const half = join(root, 'half')
    mkdirSync(half)
    writeFileSync(join(half, 'crewbox.db'), 'half a database')

    const result = run('restore.sh', [half], { DATA_DIR: spare, BACKUP_DIR: backupDir })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('did not finish')
    // Nothing touched: the spare is still whatever it was.
    expect(listing(spare)).toEqual([])
  })

  it('refuses a named directory whose database is damaged, moving nothing aside', () => {
    const { root, backupDir, spare } = roundTrip()
    const good = listing(backupDir)[0]
    // The spare already has data on it — the case where a wrong restore
    // costs something.
    mkdirSync(spare, { recursive: true })
    writeFileSync(join(spare, 'crewbox.db'), 'the spare own database')

    const broken = join(root, 'broken')
    mkdirSync(broken)
    const sound = readFileSync(join(backupDir, good, 'crewbox.db'))
    writeFileSync(join(broken, 'crewbox.db'), sound.subarray(0, 512))
    writeFileSync(join(broken, 'MANIFEST.txt'), 'taken: whenever\n')

    const result = run('restore.sh', [broken], { DATA_DIR: spare, BACKUP_DIR: backupDir })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not read')
    expect(readFileSync(join(spare, 'crewbox.db'), 'utf8')).toBe('the spare own database')
    expect(listing(root).filter((n) => n.startsWith('spare.superseded'))).toEqual([])
  })

  it('says there is nothing usable rather than restoring rubbish', () => {
    const root = scratch()
    const backupDir = join(root, 'backups')
    mkdirSync(join(backupDir, '20260101-000000'), { recursive: true })
    const result = run('restore.sh', [], { DATA_DIR: join(root, 'spare'), BACKUP_DIR: backupDir })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no usable backup')
  })
})
