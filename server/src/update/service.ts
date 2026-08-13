import { downloadBuild, type DownloadIo } from './download.ts'
import { detectTarget, installBuild, type InstallTarget } from './install.ts'
import { restartInto, type RestartIo } from './restart.ts'
import { pruneSnapshots, snapshotDb } from './snapshot.ts'
import { assetFor } from './verify.ts'

/**
 * The update, as a thing with a state somebody is watching.
 *
 * Downloading two hundred megabytes over a venue's uplink and then restarting
 * the box are both slow, and neither can happen inside an HTTP request: the
 * request that starts an install is served by the process the install is about
 * to replace. So the flow lives here, the routes only push it along and read
 * it, and the panel polls.
 *
 * **The order is the safety.** Snapshot, then swap, then release the port,
 * then start the new box and watch it. Every step before the last is
 * reversible, and the last one is supervised by the process that can undo it.
 *
 * The one thing this deliberately does *not* own is the decision. Whether an
 * update is a good idea right now is a question about a show, and `guard.ts`
 * answers it with facts rather than a verdict.
 */

export type UpdateStage = 'idle' | 'downloading' | 'ready' | 'installing' | 'failed'

export interface UpdateFlow {
  stage: UpdateStage
  /** The version being worked on, when there is one. */
  version: string | null
  /** The verified build waiting to be installed. */
  build: { name: string; bytes: number; sha256: string } | null
  /** What went wrong. Cleared when something new is started. */
  error: string | null
  /**
   * Whether this box can install anything at all.
   *
   * False from source, where there is no binary to swap. Saying so up front
   * is what stops the panel offering a button that could only ever fail.
   */
  canInstall: boolean
  /** Why not, in words, when it cannot. */
  blocked: string | null
}

export interface UpdateServiceOptions {
  dataDir: string
  /** The live database, so it can be copied before anything changes. */
  dbPath: string
  currentVersion: string
  /** Where to ask the new box whether it is serving. */
  healthUrl: string
  /**
   * Stop accepting connections, freeing the port for the new box.
   *
   * Separate from "shut down": the process must stay alive to supervise, and
   * has to be able to take the port back if the new build never answers.
   */
  releasePort: () => Promise<void>
  /** Take the port back, after a rollback. */
  regainPort: () => Promise<void>
  /** Leave, once the new box is confirmed serving. */
  exit: () => void
  /** True only for a packaged box. */
  packaged: boolean
  target?: InstallTarget
  keys?: readonly string[]
  downloadIo?: DownloadIo
  restartIo?: RestartIo
  platform?: NodeJS.Platform
  base?: string
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
}

export class UpdateService {
  private stage: UpdateStage = 'idle'
  private version: string | null = null
  private build: UpdateFlow['build'] = null
  private error: string | null = null
  private readonly target: InstallTarget
  private readonly platform: NodeJS.Platform

  constructor(private readonly options: UpdateServiceOptions) {
    this.platform = options.platform ?? process.platform
    this.target = options.target ?? detectTarget(process.execPath, this.platform)
  }

  state(): UpdateFlow {
    const blocked = this.whyBlocked()
    return {
      stage: this.stage,
      version: this.version,
      build: this.build,
      error: this.error,
      canInstall: blocked === null,
      blocked,
    }
  }

  /** Whether this box could install a build, and why not if it could not. */
  private whyBlocked(): string | null {
    if (!this.options.packaged) {
      return 'this box runs from source — update it with git, not from here'
    }
    if (!assetFor('v0.0.0', this.platform)) {
      return 'there is no crewbox build for this platform'
    }
    return null
  }

  /** True while something long-running is in flight. */
  busy(): boolean {
    return this.stage === 'downloading' || this.stage === 'installing'
  }

  /**
   * Fetch and verify a release, without installing it.
   *
   * Returns as soon as the download starts. A route that awaited this would
   * hold a request open for the length of a two-hundred-megabyte transfer over
   * whatever the venue calls broadband.
   */
  start(version: string): { ok: true } | { ok: false; reason: string } {
    const blocked = this.whyBlocked()
    if (blocked) return { ok: false, reason: blocked }
    if (this.busy()) return { ok: false, reason: `already ${this.stage}` }

    this.stage = 'downloading'
    this.version = version
    this.build = null
    this.error = null

    void this.run(version)
    return { ok: true }
  }

  private async run(version: string): Promise<void> {
    try {
      const result = await downloadBuild({
        version,
        dataDir: this.options.dataDir,
        ...(this.options.downloadIo ? { io: this.options.downloadIo } : {}),
        ...(this.options.keys ? { keys: this.options.keys } : {}),
        platform: this.platform,
        ...(this.options.base ? { base: this.options.base } : {}),
        ...(this.options.log ? { log: this.options.log } : {}),
      })
      if (!result.ok) {
        this.fail(result.reason)
        return
      }
      this.build = {
        name: result.build.name,
        bytes: result.build.bytes,
        sha256: result.build.sha256,
      }
      this.stage = 'ready'
    } catch (err) {
      // downloadBuild is written not to throw, so reaching here means a bug
      // rather than a network problem. Still not a reason to leave the panel
      // spinning for ever.
      this.fail(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Install what was downloaded, restart into it, and roll back if it will
   * not come up.
   *
   * Only returns when something has gone wrong: on success the new box is
   * serving and this process has been told to leave.
   */
  async install(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const blocked = this.whyBlocked()
    if (blocked) return { ok: false, reason: blocked }
    if (this.stage !== 'ready' || !this.build || !this.version) {
      return { ok: false, reason: 'there is no verified build waiting to be installed' }
    }

    this.stage = 'installing'
    this.error = null
    const version = this.version
    const buildPath = `${this.options.dataDir}/updates/${this.build.name}`

    // The database first, because migrations are forward-only: an old binary
    // in front of a database a newer build has migrated does not crash, it
    // quietly serves a schema it does not understand. A rollback without this
    // is only half a rollback.
    const snapshot = snapshotDb({
      dbPath: this.options.dbPath,
      dataDir: this.options.dataDir,
      version: this.options.currentVersion,
    })
    if (!snapshot.ok) {
      return this.failWith(`could not copy the database first: ${snapshot.reason}`)
    }
    pruneSnapshots(this.options.dataDir)
    this.options.log?.info(`update: database copied to ${snapshot.snapshot.name}`)

    const installed = installBuild({
      target: this.target,
      buildPath,
      fromVersion: this.options.currentVersion,
      toVersion: version,
      dataDir: this.options.dataDir,
      snapshotPath: snapshot.snapshot.path,
    })
    if (!installed.ok) {
      return this.failWith(installed.reason)
    }

    // Only now is the port let go. Everything above is reversible without
    // anybody noticing; from here the box is off the air until one of the two
    // builds is answering.
    try {
      await this.options.releasePort()
    } catch (err) {
      return this.failWith(
        `could not free the port to restart: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const restarted = await restartInto({
      inFlight: installed.inFlight,
      dataDir: this.options.dataDir,
      healthUrl: this.options.healthUrl,
      ...(this.options.restartIo ? { io: this.options.restartIo } : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
    })
    if (restarted.ok) {
      this.options.log?.info(`update: ${version} is serving — this process is done`)
      this.options.exit()
      return { ok: true }
    }

    // The new build did not come up. `restartInto` has already put the old
    // binary back, so this process is once again the right one to be running
    // — it just has to start answering again.
    try {
      await this.options.regainPort()
    } catch (err) {
      // Now genuinely bad: rolled back but not listening. Say so loudly; a
      // restart by hand fixes it, and nothing else will.
      this.options.log?.warn(
        `update: rolled back but could not listen again — restart the box by hand (${
          err instanceof Error ? err.message : String(err)
        })`
      )
    }
    const detail = restarted.rolledBack
      ? 'the previous version has been put back'
      : `the previous version could NOT be put back${
          restarted.rollbackError ? `: ${restarted.rollbackError}` : ''
        }`
    return this.failWith(`${restarted.reason} — ${detail}`)
  }

  /** Forget a failure so the panel offers to try again. */
  reset(): void {
    if (this.busy()) return
    this.stage = this.build ? 'ready' : 'idle'
    this.error = null
  }

  private fail(reason: string): void {
    this.stage = 'failed'
    this.error = reason
    this.options.log?.warn(`update: ${reason}`)
  }

  private failWith(reason: string): { ok: false; reason: string } {
    this.fail(reason)
    return { ok: false, reason }
  }
}
