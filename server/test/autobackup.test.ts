import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AutoBackup, KEEP, checkBackupDir } from '../src/autobackup.ts'
import { lastBackup } from '../src/backupmark.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'

/**
 * The box backs itself up, in backup.sh's layout, so restore.sh and the
 * runbook's hand restore read what it writes.
 */

let root: string
let dataDir: string
let stick: string
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crewbox-autobackup-'))
  dataDir = join(root, 'data')
  stick = join(root, 'stick')
  mkdirSync(join(dataDir, 'files', 'ab'), { recursive: true })
  // A live database, open and written to, as the box's is.
  store = new Store(openDb(join(dataDir, 'crewbox.db')))
  store.createChannel('general', 'public', 'Everyone')
  store.setSetting('eventName', 'Ashton Court 2026')
  writeFileSync(join(dataDir, 'files', 'ab', 'abcdef'), 'a photo of the rider')
  writeFileSync(join(dataDir, 'cert.pem'), 'CERT')
  writeFileSync(join(dataDir, 'crewbox-v1.1.0.apk'), 'APK')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const at = (second: number) => () => new Date(2026, 8, 26, 18, 0, second)

describe("the box's own backup", () => {
  it('writes what backup.sh writes, where restore.sh looks, and leaves the mark', async () => {
    const backups = new AutoBackup({ dataDir, chosenDir: () => stick, now: at(0) })
    const mark = await backups.run()
    const dest = join(stick, '20260926-180000')
    expect(mark.dest).toBe(dest)
    expect(lastBackup(dataDir)?.dest).toBe(dest)
    expect(readdirSync(dest).sort()).toEqual(
      ['MANIFEST.txt', 'cert.pem', 'crewbox-v1.1.0.apk', 'crewbox.db', 'files'].sort()
    )
    expect(readFileSync(join(dest, 'files', 'ab', 'abcdef'), 'utf8')).toBe('a photo of the rider')
    const manifest = readFileSync(join(dest, 'MANIFEST.txt'), 'utf8')
    expect(manifest).toMatch(/^tls: {6}included$/m)
    expect(manifest).toMatch(/^uploads: {2}1$/m)

    // The snapshot is a whole database, readable on its own.
    const copy = new DatabaseSync(join(dest, 'crewbox.db'), { readOnly: true })
    try {
      const row = copy.prepare("SELECT value FROM settings WHERE key = 'eventName'").get() as {
        value: string
      }
      expect(row.value).toBe('Ashton Court 2026')
      expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally {
      copy.close()
    }
  })

  it('links uploads the last backup already has rather than copying them again', async () => {
    let second = 0
    const backups = new AutoBackup({ dataDir, chosenDir: () => stick, now: () => at(second)() })
    await backups.run()
    second = 30
    await backups.run()
    const first = statSync(join(stick, '20260926-180000', 'files', 'ab', 'abcdef'))
    const next = statSync(join(stick, '20260926-180030', 'files', 'ab', 'abcdef'))
    expect(next.ino).toBe(first.ino)
  })

  it(`keeps the newest ${KEEP}, and sweeps what an interrupted run left`, async () => {
    mkdirSync(stick)
    for (let i = 0; i < KEEP + 3; i++)
      mkdirSync(join(stick, `20260901-0000${String(i).padStart(2, '0')}`))
    mkdirSync(join(stick, '20260925-120000.partial'))
    await new AutoBackup({ dataDir, chosenDir: () => stick, now: at(0) }).run()
    const left = readdirSync(stick).sort()
    expect(left).toHaveLength(KEEP)
    expect(left.at(-1)).toBe('20260926-180000')
    expect(left.some((n) => n.endsWith('.partial'))).toBe(false)
  })

  it('takes the next second’s name when two land in the same one', async () => {
    const backups = new AutoBackup({ dataDir, chosenDir: () => stick, now: at(0) })
    await backups.run()
    await backups.run()
    expect(readdirSync(stick).sort()).toEqual(['20260926-180000', '20260926-180001'])
  })

  it('goes into the data folder’s backups/ until an admin chooses a folder, and says it shares the disk', async () => {
    const backups = new AutoBackup({ dataDir, chosenDir: () => undefined, now: at(0) })
    await backups.run()
    const state = backups.state()
    expect(state.dir).toBe(join(dataDir, 'backups'))
    expect(state.chosen).toBe(false)
    expect(state.sameDisk).toBe(true)
    expect(existsSync(join(dataDir, 'backups', '20260926-180000', 'crewbox.db'))).toBe(true)
  })

  it('says why it failed, and clears that once it works', async () => {
    const warnings: string[] = []
    let dir = join(dataDir, 'crewbox.db', 'not-a-folder')
    const backups = new AutoBackup({
      dataDir,
      chosenDir: () => dir,
      now: at(0),
      warn: (m) => warnings.push(m),
    })
    await expect(backups.run()).rejects.toThrow()
    expect(backups.state().error).toBeTruthy()
    expect(warnings).toHaveLength(1)
    dir = stick
    await backups.run()
    expect(backups.state().error).toBeNull()
  })

  it('refuses a folder that is not a full path, or is the box’s own data', () => {
    expect(checkBackupDir('usb/backups', dataDir)).toMatch(/full path/)
    expect(checkBackupDir(dataDir, dataDir)).toMatch(/own data folder/)
    expect(checkBackupDir(join(dataDir, 'files', 'x'), dataDir)).toMatch(/own data folder/)
    expect(checkBackupDir(stick, dataDir)).toBeNull()
    expect(checkBackupDir(join(dataDir, 'backups'), dataDir)).toBeNull()
  })
})
