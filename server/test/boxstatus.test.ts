import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearBoxStatus,
  readBoxStatus,
  statusPath,
  stopRunningBox,
  writeBoxStatus,
  type BoxStatus,
} from '../src/box.ts'

/**
 * The status file is what the macOS menu-bar item and the Windows tray icon
 * read, and what `--stop` acts on.
 *
 * It exists because a double-clicked box had no way to be stopped: the
 * binary is a Node SEA, so a .app launched from Finder has no terminal to
 * print to and — never having linked AppKit — no Dock icon either. It ran
 * invisibly and could only be killed from Activity Monitor.
 *
 * The liveness check is the part worth guarding. A box killed by a power cut
 * leaves its file behind, and a helper that believes it would offer to open a
 * box that isn't there and a Quit that does nothing.
 */
describe('box status file', () => {
  let dir: string

  const sample = (over: Partial<BoxStatus> = {}): BoxStatus => ({
    pid: process.pid,
    port: 8787,
    secure: false,
    joinUrl: 'http://192.168.1.10:8787',
    urls: ['http://192.168.1.10:8787'],
    eventPin: '4242',
    eventName: 'Test Fest',
    version: '0.7.1',
    ...over,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crewbox-status-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips what a helper needs to draw its menu', () => {
    writeBoxStatus(dir, sample())
    const status = readBoxStatus(dir)
    expect(status?.eventName).toBe('Test Fest')
    expect(status?.eventPin).toBe('4242')
    expect(status?.joinUrl).toBe('http://192.168.1.10:8787')
    expect(status?.pid).toBe(process.pid)
  })

  it('reports nothing when no box has ever run here', () => {
    expect(readBoxStatus(dir)).toBeNull()
  })

  it('treats a file left by a dead box as not running', () => {
    // A pid that cannot be live: kernels reject 0x7FFFFFFF as out of range,
    // so this never collides with a real process on a busy machine.
    writeBoxStatus(dir, sample({ pid: 0x7fffffff }))
    expect(readBoxStatus(dir)).toBeNull()
  })

  it('treats a truncated file as not running rather than throwing', () => {
    // A power cut mid-write is exactly the case this product assumes.
    writeFileSync(statusPath(dir), '{"pid": 12')
    expect(readBoxStatus(dir)).toBeNull()
  })

  it('ignores a file with no pid in it', () => {
    writeFileSync(statusPath(dir), JSON.stringify({ port: 8787 }))
    expect(readBoxStatus(dir)).toBeNull()
  })

  it('clears on shutdown, and clearing twice is not an error', () => {
    writeBoxStatus(dir, sample())
    expect(readBoxStatus(dir)).not.toBeNull()
    clearBoxStatus(dir)
    expect(readBoxStatus(dir)).toBeNull()
    expect(() => clearBoxStatus(dir)).not.toThrow()
  })

  it('never throws when the status file cannot be written', () => {
    // Startup must not die because a status file could not be saved: a box
    // with no menu is the situation we were already in, a box that will not
    // start is worse.
    //
    // A regular file standing in for the directory, so the write fails with
    // ENOTDIR immediately. Not a made-up path under /proc — that is a virtual
    // filesystem, and a recursive mkdir into one can block rather than fail,
    // which hangs the run instead of testing anything.
    const notADir = join(dir, 'regular-file')
    writeFileSync(notADir, 'x')
    expect(() => writeBoxStatus(notADir, sample())).not.toThrow()
  })
})

/**
 * `crewbox --stop`, which is the one stop mechanism that works everywhere —
 * a headless box in a shed has no tray to click.
 *
 * The thing worth testing is what it means when it *returns*. Its own
 * comment says the caller's next move is usually to replace the binary, and
 * on Windows that fails while the old process still holds it — so returning
 * early is not a nicety, it is the promise being broken.
 *
 * A real child process, because the question is about a real one going away.
 */
describe('stopping a running box', () => {
  let dir: string
  let child: ChildProcess | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crewbox-stop-'))
  })

  afterEach(() => {
    child?.kill('SIGKILL')
    child = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  const status = (pid: number): BoxStatus => ({
    pid,
    port: 8787,
    secure: false,
    joinUrl: 'http://192.168.1.10:8787',
    urls: ['http://192.168.1.10:8787'],
    eventPin: '4242',
    eventName: 'Test Fest',
    version: '0.18.0',
  })

  it('says nothing is running when nothing is', async () => {
    expect(await stopRunningBox(dir)).toBe(0)
  })

  it('does not return until the process has actually gone', async () => {
    // A child that takes its time on SIGTERM and removes the status file
    // first — which is exactly what the box does, deliberately, so no helper
    // offers to open a box that is on its way down. Everything that makes
    // waiting worth doing happens afterwards: the sockets, the SFU, the
    // database.
    child = spawn(
      process.execPath,
      [
        '-e',
        `const { rmSync } = require('node:fs')
         process.on('SIGTERM', () => {
           rmSync(process.argv[1], { force: true })
           setTimeout(() => process.exit(0), 600)
         })
         setInterval(() => {}, 1000)`,
        statusPath(dir),
      ],
      { stdio: 'ignore' }
    )
    const pid = child.pid!
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeBoxStatus(dir, status(pid))

    const started = Date.now()
    expect(await stopRunningBox(dir)).toBe(0)
    // It waited for the process rather than for the file, which the child
    // deleted immediately. Waiting on the file returned inside a few
    // milliseconds — and the box's port, database and SFU were all still
    // open at that point.
    expect(Date.now() - started).toBeGreaterThan(400)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('reports a status file left behind by a power cut as nothing to stop', () => {
    // The pid is checked rather than trusted, so a stale file does not send
    // a signal to whatever inherited the number.
    writeBoxStatus(dir, status(0x7fffffff))
    expect(readBoxStatus(dir)).toBeNull()
  })
})
