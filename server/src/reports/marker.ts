import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * "Was the last run a clean one?"
 *
 * Every box process writes `running-<pid>.json` into its data directory as it
 * starts and deletes it on a clean shutdown. A marker left behind by a process
 * that is no longer alive is a box that did not shut down: killed, out of
 * memory, a native crash in the SFU's parent, a power cut, a lid closed on a
 * laptop with no battery.
 *
 * One file per process, not one shared file, because an update runs two boxes
 * side by side for a few seconds — the new one starting while the old one
 * watches it — and either may be the one that survives. Each only ever
 * removes its own marker, so neither can erase the evidence of the other.
 *
 * Reaches real boxes: the file name pattern is read back by every later
 * version, so do not rename it.
 */

export const MARKER_PREFIX = 'running-'

export interface RunMarker {
  pid: number
  version: string
  startedAt: number
}

/** Whether a pid is a live process. EPERM means alive but not ours. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface MarkerIo {
  alive: (pid: number) => boolean
}

const realIo: MarkerIo = { alive }

/**
 * Record that this process has started, and collect every earlier run that
 * never said it had stopped. The stale markers are deleted as they are
 * collected, so each unclean exit is reported once.
 *
 * Never throws: a data directory that cannot be written is a problem the box
 * reports elsewhere, and it must not stop the box starting.
 */
export function claimRunMarker(dataDir: string, me: RunMarker, io: MarkerIo = realIo): RunMarker[] {
  const unclean: RunMarker[] = []
  let names: string[] = []
  try {
    names = readdirSync(dataDir).filter(
      (name) => name.startsWith(MARKER_PREFIX) && name.endsWith('.json')
    )
  } catch {
    // No directory yet: a first run, which is clean by definition.
  }
  for (const name of names) {
    const path = join(dataDir, name)
    let marker: RunMarker | null = null
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunMarker>
      if (typeof parsed.pid === 'number') {
        marker = {
          pid: parsed.pid,
          version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
          startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
        }
      }
    } catch {
      // Unreadable: written by a process that died mid-write. Still a run
      // that did not end cleanly, just one we know less about.
      const pid = Number(name.slice(MARKER_PREFIX.length, -'.json'.length))
      if (Number.isInteger(pid)) marker = { pid, version: 'unknown', startedAt: 0 }
    }
    if (!marker || marker.pid === me.pid) continue
    // Still running: the other half of an update, or a box this one is about
    // to refuse to start beside. Not ours to judge.
    if (io.alive(marker.pid)) continue
    unclean.push(marker)
    try {
      rmSync(path, { force: true })
    } catch {
      // Reported once anyway; if it cannot be removed it will be again.
    }
  }
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, `${MARKER_PREFIX}${me.pid}.json`), JSON.stringify(me))
  } catch {
    // See above: never a reason not to start.
  }
  return unclean
}

/** A clean shutdown: remove this process's marker, and only this one's. */
export function releaseRunMarker(dataDir: string, pid: number = process.pid): void {
  try {
    rmSync(join(dataDir, `${MARKER_PREFIX}${pid}.json`), { force: true })
  } catch {
    // Nothing a shutting-down box can do about it.
  }
}
