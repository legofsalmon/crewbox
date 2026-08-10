/**
 * When this box was last backed up — as far as the box can tell.
 *
 * The runbook has said "rehearse the swap, an untested backup is not a
 * backup" since the deploy scripts were written, and `deploy/backup.sh` does
 * the right thing. What has been missing is any way to find out that nobody
 * ran it. A backup regime that quietly stopped three events ago looks
 * identical, from the production desk, to one that ran last night.
 *
 * The box cannot go looking: backups land wherever BACKUP_DIR pointed, which
 * is usually a USB stick that is not plugged in right now. So backup.sh
 * leaves a marker in the data directory when it finishes, and this reads it.
 * That reports the fact that actually matters — a backup completed, at this
 * time, to here — regardless of where it went or whether that volume is
 * still attached.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MARK_FILE = 'last-backup.json'

export interface BackupMark {
  /** When the backup finished (epoch ms). */
  at: number
  /** Where it was written, so the panel can name it. Not a secret. */
  dest?: string
}

/** Parse the marker, tolerating anything at all in the file. */
export function parseBackupMark(text: string): BackupMark | null {
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return null
    const { at, dest } = raw as { at?: unknown; dest?: unknown }
    // Seconds vs milliseconds is the classic way this goes wrong, and a
    // marker in seconds would read as 1970 and shout about a 56-year-old
    // backup. Anything before 2020 is not a plausible millisecond stamp.
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 1_577_836_800_000) return null
    return { at, ...(typeof dest === 'string' && dest ? { dest } : {}) }
  } catch {
    return null
  }
}

/** The marker in this box's data directory, or null if never backed up. */
export function lastBackup(dataDir: string): BackupMark | null {
  try {
    return parseBackupMark(readFileSync(join(dataDir, MARK_FILE), 'utf8'))
  } catch {
    return null
  }
}
