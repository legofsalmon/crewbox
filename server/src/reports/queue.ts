import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CrashReport, FeedbackReport } from './payload.ts'

/**
 * Reports waiting to leave the box, one JSON file each.
 *
 * A festival box is offline for days, so every report is written here first
 * and sent when there is a network — possibly next week, possibly never. Files
 * rather than database rows so that a crash handler can write one without the
 * database (which may be the thing that just failed), and so an operator can
 * see, read or delete what is waiting with nothing but a file browser.
 *
 * Bounded at twenty: the oldest goes first. A box stuck in a loop must not
 * fill its own disk with reports about the loop.
 */

export const MAX_QUEUED = 20

/** The directory under the box's data dir. Reaches real boxes: do not rename. */
export const REPORTS_DIR = 'reports'

/**
 * Whether a report may leave the box.
 *
 * `pending` is a crash nobody has agreed to send yet — the admin panel asks
 * once. `granted` is one that may go: feedback someone pressed Send on, a
 * crash someone pressed Send on, or any crash while "Send crash reports
 * automatically" is on.
 */
export type Consent = 'pending' | 'granted'

export type QueuedReport =
  | { id: string; endpoint: 'crash'; consent: Consent; queuedAt: number; payload: CrashReport }
  | {
      id: string
      endpoint: 'feedback'
      consent: Consent
      queuedAt: number
      payload: FeedbackReport
    }

export type NewReport =
  | { endpoint: 'crash'; consent: Consent; payload: CrashReport }
  | { endpoint: 'feedback'; consent: Consent; payload: FeedbackReport }

const FILE = /^[0-9a-z]{21}\.json$/

let sequence = 0

/**
 * A file name that sorts in the order reports were queued: milliseconds, then
 * a per-process counter (two reports in one millisecond still keep their
 * order), then randomness so two processes never collide. 21 characters of
 * [0-9a-z], like the shared `newId()` it is modelled on.
 */
function queueId(now = Date.now()): string {
  const time = now.toString(36).padStart(9, '0').slice(-9)
  const seq = (sequence++ % 36 ** 4).toString(36).padStart(4, '0')
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  let rand = ''
  for (const b of bytes) rand += (b % 36).toString(36)
  return time + seq + rand
}

export class ReportQueue {
  readonly dir: string
  private readonly max: number

  constructor(dir: string, max = MAX_QUEUED) {
    this.dir = dir
    this.max = max
  }

  /** Oldest first. A file that will not parse is removed, not reported. */
  list(): QueuedReport[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
      // A `.partial` is a write that never finished; nothing will finish it.
      for (const name of names) if (name.endsWith('.partial')) this.removeFile(name)
      names = names.filter((name) => FILE.test(name))
    } catch {
      return []
    }
    const out: QueuedReport[] = []
    // newId() is time-sortable, so name order is queue order.
    for (const name of names.sort()) {
      try {
        const parsed = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as QueuedReport
        if (
          (parsed.endpoint === 'crash' || parsed.endpoint === 'feedback') &&
          (parsed.consent === 'pending' || parsed.consent === 'granted') &&
          typeof parsed.payload === 'object' &&
          parsed.payload !== null
        ) {
          out.push({ ...parsed, id: name.slice(0, -'.json'.length) })
          continue
        }
      } catch {
        // Half-written by a process that died mid-write, or edited by hand.
      }
      this.removeFile(name)
    }
    return out
  }

  /** Write one report, then drop the oldest beyond the bound. Never throws. */
  add(report: NewReport, now = Date.now()): QueuedReport | null {
    const id = queueId()
    const entry = { ...report, id, queuedAt: now } as QueuedReport
    try {
      mkdirSync(this.dir, { recursive: true })
      // Written aside and renamed, so a reader never sees half a report.
      const final = join(this.dir, `${id}.json`)
      const partial = `${final}.partial`
      writeFileSync(partial, JSON.stringify(entry))
      renameSync(partial, final)
    } catch {
      // A full or read-only disk. The report is lost; the box is not.
      return null
    }
    const all = this.list()
    for (const old of all.slice(0, Math.max(0, all.length - this.max))) this.remove(old.id)
    return entry
  }

  /** Rewrite one report's consent. False when it is no longer there. */
  setConsent(id: string, consent: Consent): boolean {
    const entry = this.list().find((e) => e.id === id)
    if (!entry) return false
    try {
      const final = join(this.dir, `${id}.json`)
      writeFileSync(`${final}.partial`, JSON.stringify({ ...entry, consent }))
      renameSync(`${final}.partial`, final)
      return true
    } catch {
      return false
    }
  }

  remove(id: string): void {
    this.removeFile(`${id}.json`)
  }

  private removeFile(name: string): void {
    try {
      rmSync(join(this.dir, name), { force: true })
    } catch {
      // Already gone, or not ours to delete. Either way nothing to do.
    }
  }
}
