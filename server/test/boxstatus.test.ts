import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearBoxStatus,
  readBoxStatus,
  statusPath,
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
