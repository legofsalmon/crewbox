import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OLD_SUFFIX, inFlightPath, installBuild, type InFlight } from '../src/update/install.ts'
import {
  healthMatches,
  restartInto,
  statusFileProbe,
  type RestartIo,
} from '../src/update/restart.ts'

/**
 * Launching the new box and deciding whether to keep it.
 *
 * The arrangement under test: the *old* process is the supervisor, because a
 * build that will not start cannot be the thing that notices it did not
 * start. So every failure here has to end with the old binary back at its own
 * path and the marker gone — a box that is exactly where it was before
 * somebody pressed the button.
 */

let dir: string
let target: string
let dataDir: string
let inFlight: InFlight

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-restart-'))
  dataDir = join(dir, 'data')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(dir, 'updates'), { recursive: true })
  target = join(dir, 'crewbox')
  writeFileSync(target, 'the old box')
  chmodSync(target, 0o755)
  const build = join(dir, 'updates', 'crewbox-linux-x64-v0.18.0')
  writeFileSync(build, 'the new box')
  const result = installBuild({
    target: { kind: 'binary', path: target },
    buildPath: build,
    fromVersion: '0.17.1',
    toVersion: '0.18.0',
    dataDir,
  })
  if (!result.ok) throw new Error('fixture install failed')
  inFlight = result.inFlight
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A clock that only moves when the code under test sleeps. */
function fakeIo(
  answers: ({ ok: true; version: string; pid?: number } | null)[] = [],
  overrides: Partial<RestartIo> = {}
): RestartIo & { launched: string[]; killed: number[] } {
  let clock = 0
  let asked = 0
  const launched: string[] = []
  const killed: number[] = []
  return {
    launched,
    killed,
    launch: (path) => {
      launched.push(path)
      return 4242
    },
    probe: () => Promise.resolve(answers[asked++] ?? null),
    kill: (pid) => {
      killed.push(pid)
    },
    now: () => clock,
    sleep: (ms) => {
      clock += ms
      return Promise.resolve()
    },
    ...overrides,
  }
}

const run = (io: RestartIo, timeoutMs = 5_000) =>
  restartInto({ inFlight, dataDir, healthUrl: 'http://localhost:8787/api/health', io, timeoutMs })

describe('when the new box comes up', () => {
  it('keeps it, and clears the way back', async () => {
    const io = fakeIo([null, { ok: true, version: '0.18.0+abc1234' }])
    const result = await run(io)
    expect(result.ok).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('the new box')
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(false)
    expect(existsSync(inFlightPath(dataDir))).toBe(false)
  })

  it('launches the installed binary, not the download', async () => {
    const io = fakeIo([{ ok: true, version: '0.18.0' }])
    await run(io)
    expect(io.launched).toEqual([target])
  })

  it('waits through a box that is still starting', async () => {
    // A packaged box extracts its web bundle on first boot, so the first few
    // probes finding nothing is the normal case, not a failure.
    const io = fakeIo([null, null, null, { ok: true, version: '0.18.0' }])
    const result = await run(io)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.waitedMs).toBeGreaterThan(0)
  })
})

describe('when it does not', () => {
  it('puts the old box back when nothing ever answers', async () => {
    const result = await run(fakeIo([]), 2_000)
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(readFileSync(target, 'utf8')).toBe('the old box')
    expect(existsSync(inFlightPath(dataDir))).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('did not answer')
  })

  it('stops the process it started', async () => {
    // Otherwise a box that is up but not serving sits there holding the port
    // against the old build we are about to restore.
    const io = fakeIo([])
    await run(io, 2_000)
    expect(io.killed).toEqual([4242])
  })

  it('rolls back when something else answers on the port', async () => {
    // The old box never let go. Whatever is serving is not what we installed,
    // and an unconfirmed new binary left in place is the exact state this
    // mechanism exists to prevent.
    const io = fakeIo([{ ok: true, version: '0.17.1+deadbee' }])
    const result = await run(io)
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(readFileSync(target, 'utf8')).toBe('the old box')
    if (result.ok) return
    expect(result.reason).toContain('0.17.1')
  })

  it('rolls back when the new box will not launch at all', async () => {
    const io = fakeIo([], {
      launch: () => {
        throw new Error('EACCES')
      },
    })
    const result = await run(io)
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(readFileSync(target, 'utf8')).toBe('the old box')
  })

  it('rolls back when the launch reports no pid', async () => {
    const io = fakeIo([], { launch: () => 0 })
    const result = await run(io)
    expect(result).toMatchObject({ ok: false, rolledBack: true })
  })

  it('says so plainly when even the rollback failed', async () => {
    // The worst case, and the one an operator most needs told: the new box
    // did not come up *and* the old one could not be put back.
    rmSync(inFlight.backupPath)
    const result = await run(fakeIo([]), 2_000)
    expect(result).toMatchObject({ ok: false, rolledBack: false })
    if (result.ok) return
    expect(result.rollbackError).toBeTruthy()
  })
})

describe('recognising our own build', () => {
  it('ignores the commit suffix /api/health carries', () => {
    // Health reports `0.18.0+abc1234`; a release is tagged `v0.18.0`. The
    // suffix is not knowable from the tag, so requiring an exact match would
    // roll back every successful install.
    expect(healthMatches('0.18.0+abc1234', 'v0.18.0')).toBe(true)
    expect(healthMatches('0.18.0', '0.18.0')).toBe(true)
    expect(healthMatches('v0.18.0+a', 'v0.18.0+b')).toBe(true)
  })

  it('still tells different versions apart', () => {
    expect(healthMatches('0.17.1+abc', 'v0.18.0')).toBe(false)
    expect(healthMatches('0.18.10', 'v0.18.1')).toBe(false)
  })
})

describe('asking the status file instead of the network', () => {
  /**
   * Chosen over an HTTP probe because a box serving HTTPS with its own
   * certificate would fail fetch's verification, and a successful update
   * would be rolled back for having the wrong certificate authority.
   */
  it('accepts a file written by the new process, and names it', async () => {
    // The pid matters as much as the version: on macOS the launch went
    // through `open`, so this file is the only place the new box's own pid
    // can be read.
    const probe = statusFileProbe('/data', 100, () => ({ pid: 200, version: '0.18.0' }))
    expect(await probe('ignored')).toEqual({ ok: true, version: '0.18.0', pid: 200 })
  })

  it('ignores our own status file', async () => {
    // The old process's file sits on disk throughout the restart — it only
    // clears on shutdown. Reading version alone would find the OLD version,
    // decide something else had taken the port, and roll back a perfectly
    // good install.
    const probe = statusFileProbe('/data', 100, () => ({ pid: 100, version: '0.17.1' }))
    expect(await probe('ignored')).toBeNull()
  })

  it('waits quietly while there is no file at all', async () => {
    const probe = statusFileProbe('/data', 100, () => null)
    expect(await probe('ignored')).toBeNull()
  })

  it('does not treat a versionless status as serving', async () => {
    // A box built from source writes no DEPLOY_VERSION. Nothing to compare
    // against is not the same as a match.
    const probe = statusFileProbe('/data', 100, () => ({ pid: 200, version: '' }))
    expect(await probe('ignored')).toBeNull()
  })
})

/**
 * Stopping the right process.
 *
 * A `.app` is launched with `open -n`, which hands the request to
 * LaunchServices and exits — so the pid that comes back belongs to a process
 * that is already gone. Killing it stopped nothing, and a box that failed its
 * probe went on holding the port while this process rolled back and tried to
 * take it: two boxes, one port, and a rollback that had not really happened.
 */
describe('killing a box that will not come good', () => {
  it('kills what answered, not what was launched', async () => {
    // 4242 is the launch pid — `open`, already gone. 8080 is the box, read
    // from the status file it wrote.
    const io = fakeIo([{ ok: true, version: '9.9.9', pid: 8080 }])
    await run(io)
    expect(io.killed).toEqual([8080])
  })

  it('falls back to the launched pid when nothing ever answered', async () => {
    // A plain binary is its own launcher, so that pid is the box — and it is
    // the only one there is when no probe came back.
    const io = fakeIo([])
    await run(io, 2_000)
    expect(io.killed).toEqual([4242])
  })
})
