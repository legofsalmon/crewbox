/**
 * The box backs itself up.
 *
 * `deploy/backup.sh` has always done this well, and only when somebody ran
 * it: by hand, from cron on a rig somebody set up, never on the Mac or
 * Windows box, which has no bash and no cron entry. A box that died with no
 * backup took the event's chat, accounts, uploads and PIN with it, and the
 * admin panel could only say, afterwards, that nobody had run the script.
 *
 * So the box takes the same backup itself, every few hours, into a folder an
 * admin chooses (a USB stick, ideally), and "Back up now" takes one on
 * demand. It writes exactly what backup.sh writes, laid out the same way, so
 * `deploy/restore.sh` and the hand restore in the runbook read either:
 *
 *   <folder>/<YYYYmmdd-HHMMSS>/crewbox.db     a consistent snapshot
 *                              files/          uploads
 *                              cert.pem ...    the certificate, if any
 *                              crewbox*.apk    the Android app, if any
 *                              MANIFEST.txt    what is in it
 *
 * The database snapshot is `VACUUM INTO` from a worker thread with its own
 * read-only connection, so the event loop that carries chat and voice
 * signalling never waits on it. Uploads are content-addressed and never
 * change, so a file the previous backup already holds is hard-linked rather
 * than copied: fourteen backups of a festival's photos cost one copy.
 */

import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { MARK_FILE, lastBackup, type BackupMark } from './backupmark.ts'

/** How often, unless CREWBOX_BACKUP_HOURS says otherwise. */
export const DEFAULT_EVERY_HOURS = 6
/** How many finished backups a folder keeps, as backup.sh keeps. */
export const KEEP = 14
/** A backup's folder name: backup.sh's stamp, which sorts by time. */
const STAMPED = /^\d{8}-\d{6}$/
/** The first backup waits this long after the box starts, so a restart loop cannot fill a stick. */
const FIRST_AFTER_MS = 10 * 60_000
/** Room to leave on the disk beyond what the backup needs. */
const SPARE_BYTES = 100 * 1024 * 1024

export interface AutoBackupOptions {
  dataDir: string
  /** The folder an admin chose, or undefined for the default. Read at each run. */
  chosenDir: () => string | undefined
  /** Hours between backups; 0 for none on a timer ("Back up now" still works). */
  everyHours?: number
  warn?: (message: string) => void
  info?: (message: string) => void
  now?: () => Date
}

export interface BackupState {
  /** Where the next backup goes. */
  dir: string
  /** Where it goes when no folder is chosen. */
  defaultDir: string
  /** Whether that is the default. */
  chosen: boolean
  everyHours: number
  /** Whether `dir` is on the same disk as the box's data, which a dead disk takes both of. */
  sameDisk: boolean | null
  running: boolean
  last: BackupMark | null
  /** Why the last attempt failed, until one succeeds. */
  error: string | null
}

/**
 * Why a folder an admin typed can't take backups, or null if it can: it must
 * be a full path, and not the data folder itself or somewhere in its
 * uploads, which each backup copies and would then copy into itself.
 */
export function checkBackupDir(dir: string, dataDir: string): string | null {
  if (!isAbsolute(dir))
    return 'Give the full path to the folder, starting from the top of the disk.'
  const target = resolve(dir)
  const data = resolve(dataDir)
  const files = join(data, 'files')
  if (target === data || target === files || target.startsWith(files + sep)) {
    return 'That is the box’s own data folder. Choose a folder outside it, ideally on a USB stick.'
  }
  return null
}

const stamp = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Snapshot a live database to `dest` without holding up the caller's thread. */
function snapshot(src: string, dest: string): Promise<void> {
  // Plain JS, evaluated in the worker: the box is one bundled file, so the
  // worker cannot load a module of its own from disk.
  const code = `
    const { workerData, parentPort } = require('node:worker_threads')
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(workerData.src, { readOnly: true })
    try {
      db.exec("VACUUM INTO '" + workerData.dest.replaceAll("'", "''") + "'")
    } finally {
      db.close()
    }
    parentPort.postMessage('done')
  `
  return new Promise((done, fail) => {
    // Its stderr is its own: node:sqlite's experimental warning, once per
    // worker, would otherwise land in the box's log every few hours.
    const worker = new Worker(code, { eval: true, workerData: { src, dest }, stderr: true })
    worker.stderr.resume()
    let finished = false
    worker.once('message', () => {
      finished = true
      done()
    })
    worker.once('error', fail)
    worker.once('exit', (code) => {
      if (!finished) fail(new Error(`the snapshot stopped (exit ${code})`))
    })
  })
}

/** Link `from` to `to` when the previous backup has it, else copy it. */
function linkOrCopy(from: string, to: string, previous: string | null): void {
  if (previous && existsSync(previous)) {
    try {
      linkSync(previous, to)
      return
    } catch {
      // A disk without hard links (FAT on a USB stick): copy instead.
    }
  }
  copyFileSync(from, to)
}

/** Everything under `dir`, as paths relative to it. */
function walk(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) out.push(...walk(dir, rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

export class AutoBackup {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<BackupMark> | null = null
  private error: string | null = null
  private readonly everyHours: number
  private readonly now: () => Date

  constructor(private readonly options: AutoBackupOptions) {
    const hours = options.everyHours ?? DEFAULT_EVERY_HOURS
    this.everyHours = Number.isFinite(hours) && hours > 0 ? hours : 0
    this.now = options.now ?? (() => new Date())
  }

  get defaultDir(): string {
    return join(this.options.dataDir, 'backups')
  }

  get dir(): string {
    return this.options.chosenDir() || this.defaultDir
  }

  /** Back up on a timer, the first a little after the box starts. */
  start(): void {
    if (this.everyHours === 0 || this.timer) return
    const tick = () => {
      void this.run().catch(() => {
        // Recorded in `error`, shown in the admin panel, and warned once.
      })
    }
    this.timer = setTimeout(() => {
      tick()
      this.timer = setInterval(tick, this.everyHours * 60 * 60_000)
      this.timer.unref()
    }, FIRST_AFTER_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  state(): BackupState {
    const dir = this.dir
    return {
      dir,
      defaultDir: this.defaultDir,
      chosen: dir !== this.defaultDir,
      everyHours: this.everyHours,
      sameDisk: this.sameDisk(dir),
      running: this.running !== null,
      last: lastBackup(this.options.dataDir),
      error: this.error,
    }
  }

  /** Whether `dir` (or the nearest folder of it that exists) shares a disk with the data. */
  sameDisk(dir: string): boolean | null {
    try {
      let probe = resolve(dir)
      while (!existsSync(probe)) {
        const up = resolve(probe, '..')
        if (up === probe) return null
        probe = up
      }
      return statSync(probe).dev === statSync(this.options.dataDir).dev
    } catch {
      return null
    }
  }

  /** Take a backup now. One at a time: a second ask while one runs gets that one. */
  run(): Promise<BackupMark> {
    if (!this.running) {
      this.running = this.take().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  private async take(): Promise<BackupMark> {
    const { dataDir } = this.options
    const folder = this.dir
    try {
      const db = join(dataDir, 'crewbox.db')
      if (!existsSync(db)) throw new Error(`there is no crewbox.db in ${dataDir}`)
      mkdirSync(folder, { recursive: true })

      // Refuse rather than fill the disk the box runs on, or the stick.
      const need = statSync(db).size * 2 + SPARE_BYTES
      const { bavail, bsize } = statfsSync(folder)
      if (bavail * bsize < need) {
        throw new Error(`${folder} has too little free space for another backup`)
      }

      const finished = readdirSync(folder)
        .filter((name) => STAMPED.test(name))
        .sort()
      const previous = finished.length > 0 ? join(folder, finished.at(-1)!) : null

      // Two in one second ("Back up now" twice) take the next second's name,
      // so every folder keeps the stamp restore.sh looks for.
      const started = this.now().getTime()
      let name = stamp(new Date(started))
      for (let n = 1; existsSync(join(folder, name)); n++)
        name = stamp(new Date(started + n * 1000))
      const dest = join(folder, name)
      const work = `${dest}.partial`
      rmSync(work, { recursive: true, force: true })
      mkdirSync(work, { recursive: true })
      try {
        await snapshot(db, join(work, 'crewbox.db'))

        let uploads = 0
        const files = join(dataDir, 'files')
        if (existsSync(files)) {
          for (const rel of walk(files)) {
            const to = join(work, 'files', rel)
            mkdirSync(join(to, '..'), { recursive: true })
            linkOrCopy(join(files, rel), to, previous ? join(previous, 'files', rel) : null)
            uploads++
          }
        }

        const tls = ['cert.pem', 'key.pem', 'chain.pem'].filter((f) => existsSync(join(dataDir, f)))
        for (const f of tls) copyFileSync(join(dataDir, f), join(work, f))
        const apks = readdirSync(dataDir).filter((f) => /^crewbox.*\.apk$/.test(f))
        for (const f of apks) {
          linkOrCopy(join(dataDir, f), join(work, f), previous ? join(previous, f) : null)
        }

        const taken = this.now()
        writeFileSync(
          join(work, 'MANIFEST.txt'),
          [
            `taken:    ${taken.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
            `host:     ${hostname()}`,
            `data_dir: ${dataDir}`,
            `tls:      ${tls.includes('cert.pem') ? 'included' : 'NOT PRESENT — restore comes up on http'}`,
            `apk:      ${apks.length > 0 ? `${apks.length} file(s)` : 'NOT PRESENT — the poster QR 404s after a restore'}`,
            `uploads:  ${uploads}`,
            `by:       the box itself${this.everyHours ? `, every ${this.everyHours} hours` : ''}`,
            '',
          ].join('\n')
        )
        // The receipt: restore.sh trusts a stamped folder, never a .partial.
        renameSync(work, dest)
      } catch (err) {
        rmSync(work, { recursive: true, force: true })
        throw err
      }

      // Keep the newest KEEP, and sweep partials an interrupted run left.
      const now = readdirSync(folder)
      const stamped = now.filter((n) => STAMPED.test(n)).sort()
      for (const old of stamped.slice(0, Math.max(0, stamped.length - KEEP))) {
        rmSync(join(folder, old), { recursive: true, force: true })
      }
      for (const partial of now.filter((n) => n.endsWith('.partial'))) {
        rmSync(join(folder, partial), { recursive: true, force: true })
      }

      const mark: BackupMark = { at: this.now().getTime(), dest }
      writeFileSync(join(dataDir, MARK_FILE), `${JSON.stringify(mark)}\n`)
      if (this.error) this.options.info?.(`backup: working again, to ${dest}`)
      this.error = null
      return mark
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (this.error === null)
        this.options.warn?.(`backup: could not back up to ${folder} (${reason})`)
      this.error = reason
      throw err
    }
  }
}
