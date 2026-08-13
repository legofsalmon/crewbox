import { spawn } from 'node:child_process'
import { dropBackup, undoInstall, type InFlight } from './install.ts'

/**
 * Starting the new box, watching it, and putting the old one back if it does
 * not come up.
 *
 * **The process that supervises the swap is the old one — the build already
 * known to work.** That is the only arrangement where a rollback is possible
 * at the moment it is needed: a new binary that will not start cannot be the
 * thing that notices it did not start. So the running box closes its
 * listeners, launches the replacement, and waits to be told it is serving. If
 * that never happens, the old process still exists, still has the database
 * open, and can put its own binary back and carry on.
 *
 * The consequence worth understanding: there is a window, a few seconds long,
 * where nothing is listening. That is unavoidable — two boxes cannot hold the
 * same port — and it is why the flow above this warns about who is connected
 * before it starts. What is avoidable is that window being *indefinite*, and
 * that is what the health poll and the rollback are for.
 */

/** How long the new box gets to answer before it is judged dead. */
export const HEALTH_TIMEOUT_MS = 45_000

/** How often to ask, while waiting. Cheap and local. */
export const HEALTH_INTERVAL_MS = 500

/**
 * A restart drops every phone's connection, so it is worth telling people
 * roughly how long for. Measured from the box closing its listeners to the
 * new one answering: a few seconds of process start, plus the web bundle
 * extraction a packaged box does on boot.
 */
export const TYPICAL_OUTAGE_SECONDS = 20

export interface RestartIo {
  /** Launch the new box, detached, and return its pid. */
  launch: (path: string, args: string[]) => number
  /** Ask a box whether it is serving, and what it is. */
  probe: (url: string) => Promise<{ ok: boolean; version: string } | null>
  /** Stop a child that never came good. */
  kill: (pid: number) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export const realRestartIo: RestartIo = {
  launch: (path, args) => {
    // Detached with stdio ignored: the new box must outlive this process, and
    // an inherited pipe nobody reads is a box that blocks on its own logging
    // once the buffer fills.
    const child = spawn(path, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return child.pid ?? 0
  },
  probe: async (url) => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2_000)
      try {
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) return null
        const body = (await res.json()) as { ok?: boolean; version?: string }
        if (body?.ok !== true || typeof body.version !== 'string') return null
        return { ok: true, version: body.version }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return null
    }
  },
  kill: (pid) => {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone, which is the outcome we wanted anyway.
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * Does this health answer come from the build we installed?
 *
 * `/api/health` reports `0.18.0+abc1234` while a release is tagged `v0.18.0`,
 * so neither string is usable raw. Comparing the numeric version only —
 * rather than requiring an exact match — is deliberate: the commit suffix is
 * not knowable from a release tag, and a box that installed correctly but
 * reported an unexpected suffix would otherwise be rolled back for no reason.
 */
export function healthMatches(reported: string, expected: string): boolean {
  const strip = (v: string) => v.replace(/^v/, '').split('+')[0]!.trim()
  return strip(reported) === strip(expected)
}

export type RestartResult =
  | { ok: true; pid: number; waitedMs: number }
  | { ok: false; reason: string; rolledBack: boolean; rollbackError?: string }

export interface RestartOptions {
  inFlight: InFlight
  dataDir: string
  /** Where to ask whether the new box is serving. */
  healthUrl: string
  /** Passed through to the new process — normally none. */
  args?: string[]
  io?: RestartIo
  timeoutMs?: number
  intervalMs?: number
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
}

/**
 * Launch the installed build and wait for it to prove itself.
 *
 * The caller must have released the port first; this does not do it, because
 * "stop listening" belongs to whoever owns the server, and a function that
 * closed somebody else's listeners would be impossible to test and unpleasant
 * to reason about.
 *
 * Never throws. A failure here is a box that is still running the old build
 * with its old binary restored — a result to report, not an exception.
 */
export async function restartInto(options: RestartOptions): Promise<RestartResult> {
  const io = options.io ?? realRestartIo
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? HEALTH_INTERVAL_MS
  const { inFlight, dataDir } = options
  const started = io.now()

  let pid: number
  try {
    pid = io.launch(inFlight.targetPath, options.args ?? [])
  } catch (err) {
    return {
      ...rollback(inFlight, dataDir),
      reason: `could not start the new box: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!pid) {
    return { ...rollback(inFlight, dataDir), reason: 'the new box did not start' }
  }
  options.log?.info(`update: started ${inFlight.toVersion} as pid ${pid}, waiting for it to serve`)

  while (io.now() - started < timeoutMs) {
    await io.sleep(intervalMs)
    const health = await io.probe(options.healthUrl)
    if (!health) continue
    if (!healthMatches(health.version, inFlight.toVersion)) {
      // Something is serving, but it is not what we installed. Almost
      // certainly the old box never actually let go of the port. Rolling
      // back is right: we cannot confirm the new build, and leaving it in
      // place unconfirmed is the state this whole mechanism exists to avoid.
      io.kill(pid)
      return {
        ...rollback(inFlight, dataDir),
        reason: `something answered as ${health.version}, but ${inFlight.toVersion} was installed`,
      }
    }
    // Confirmed. The old binary is no longer needed, and keeping it would
    // make the next start's sweep think an install is still in flight.
    dropBackup(inFlight, dataDir)
    options.log?.info(`update: ${inFlight.toVersion} is serving`)
    return { ok: true, pid, waitedMs: io.now() - started }
  }

  io.kill(pid)
  return {
    ...rollback(inFlight, dataDir),
    reason: `${inFlight.toVersion} did not answer within ${Math.round(timeoutMs / 1000)}s`,
  }
}

function rollback(
  inFlight: InFlight,
  dataDir: string
): { ok: false; reason: string; rolledBack: boolean; rollbackError?: string } {
  const undone = undoInstall(inFlight, dataDir)
  return undone.ok
    ? { ok: false, reason: '', rolledBack: true }
    : { ok: false, reason: '', rolledBack: false, rollbackError: undone.reason }
}
