import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OLD_SUFFIX,
  clearInFlight,
  detectTarget,
  dropBackup,
  inFlightPath,
  installBuild,
  readInFlight,
  recoverInterruptedInstall,
  sweepOldBinaries,
  undoInstall,
  writeInFlight,
  type InFlight,
} from '../src/update/install.ts'

/**
 * Swapping the binary, and getting back.
 *
 * The invariant every test here defends: **at no point is there no working
 * box on disk.** Before the swap the old one is at its own path; between the
 * two renames it is at `.old`; after them the new one is in place and the old
 * one is still at `.old`. A test that ever finds neither has found the bug
 * that matters.
 */

let dir: string
let target: string
let build: string
let dataDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-install-'))
  dataDir = join(dir, 'data')
  mkdirSync(dataDir, { recursive: true })
  target = join(dir, 'crewbox')
  build = join(dir, 'updates', 'crewbox-linux-x64-v0.18.0')
  mkdirSync(join(dir, 'updates'), { recursive: true })
  writeFileSync(target, 'the old box')
  chmodSync(target, 0o755)
  writeFileSync(build, 'the new box')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const install = () =>
  installBuild({
    target: { kind: 'binary', path: target },
    buildPath: build,
    fromVersion: '0.17.1',
    toVersion: '0.18.0',
    dataDir,
    now: () => 1_700_000_000_000,
  })

describe('what is running, and how it gets replaced', () => {
  it('treats a plain binary as a plain binary', () => {
    expect(detectTarget('/opt/crewbox/crewbox', 'linux')).toEqual({
      kind: 'binary',
      path: '/opt/crewbox/crewbox',
    })
    expect(detectTarget('C:\\crewbox\\crewbox.exe', 'win32')).toEqual({
      kind: 'binary',
      path: 'C:\\crewbox\\crewbox.exe',
    })
  })

  it('recognises a box living inside a signed .app', () => {
    expect(
      detectTarget('/Applications/Crewbox.app/Contents/Resources/crewbox-server', 'darwin')
    ).toEqual({
      kind: 'app-bundle',
      appPath: '/Applications/Crewbox.app',
      execPath: '/Applications/Crewbox.app/Contents/Resources/crewbox-server',
    })
  })

  it('treats a downloaded darwin binary as a binary, not a bundle', () => {
    // A Mac box run straight from a download is an ordinary file and updates
    // like one. Only a bundle needs the bundle treatment.
    expect(detectTarget('/Users/colm/Downloads/crewbox-darwin-arm64', 'darwin')).toEqual({
      kind: 'binary',
      path: '/Users/colm/Downloads/crewbox-darwin-arm64',
    })
  })

  it('is not fooled by a directory that merely ends in .app', () => {
    expect(detectTarget('/data/notes.app/crewbox', 'darwin')).toEqual({
      kind: 'binary',
      path: '/data/notes.app/crewbox',
    })
  })

  it('refuses a bundle rather than breaking its signature', () => {
    // Replacing the binary inside a signed .app leaves Gatekeeper killing it
    // on next launch, from a double-click that explains nothing. Saying no is
    // the correct answer until the whole-bundle swap exists.
    const result = installBuild({
      target: {
        kind: 'app-bundle',
        appPath: '/Applications/Crewbox.app',
        execPath: '/Applications/Crewbox.app/Contents/Resources/crewbox-server',
      },
      buildPath: build,
      fromVersion: '0.17.1',
      toVersion: '0.18.0',
      dataDir,
    })
    expect(result).toMatchObject({ ok: false, stage: 'unsupported' })
    if (result.ok) return
    expect(result.reason).toContain('signature')
  })
})

describe('installing', () => {
  it('puts the new box in place and keeps the old one', () => {
    const result = install()
    expect(result.ok).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('the new box')
    expect(readFileSync(`${target}${OLD_SUFFIX}`, 'utf8')).toBe('the old box')
  })

  it('leaves the installed box executable', () => {
    // A rename keeps the download's mode, which is not executable. Getting
    // this wrong ships a box that cannot start.
    install()
    expect(statSync(target).mode & 0o111).toBeTruthy()
  })

  it('records the install before touching anything', () => {
    const result = install()
    expect(result.ok).toBe(true)
    const marker = readInFlight(dataDir)
    expect(marker).toMatchObject({
      fromVersion: '0.17.1',
      toVersion: '0.18.0',
      targetPath: target,
      backupPath: `${target}${OLD_SUFFIX}`,
    })
  })

  it('replaces a leftover .old from a previous update', () => {
    // Windows refuses to rename onto an existing name, so a stale backup
    // would fail every future install on that platform.
    writeFileSync(`${target}${OLD_SUFFIX}`, 'ancient history')
    expect(install().ok).toBe(true)
    expect(readFileSync(`${target}${OLD_SUFFIX}`, 'utf8')).toBe('the old box')
  })

  it('says so when the download is not there', () => {
    rmSync(build)
    expect(install()).toMatchObject({ ok: false, stage: 'missing' })
  })

  it('leaves no marker behind when it could not start', () => {
    rmSync(build)
    install()
    expect(existsSync(inFlightPath(dataDir))).toBe(false)
  })
})

describe('going back', () => {
  it('restores the old box', () => {
    const result = install()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(undoInstall(result.inFlight, dataDir)).toEqual({ ok: true })
    expect(readFileSync(target, 'utf8')).toBe('the old box')
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(false)
    expect(existsSync(inFlightPath(dataDir))).toBe(false)
  })

  it('leaves the restored box executable too', () => {
    const result = install()
    if (!result.ok) return
    undoInstall(result.inFlight, dataDir)
    expect(statSync(target).mode & 0o111).toBeTruthy()
  })

  it('says why when there is nothing to go back to', () => {
    const result = install()
    if (!result.ok) return
    rmSync(result.inFlight.backupPath)
    expect(undoInstall(result.inFlight, dataDir)).toMatchObject({ ok: false })
  })

  it('drops the backup once the new box has proved itself', () => {
    const result = install()
    if (!result.ok) return
    dropBackup(result.inFlight, dataDir)
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(false)
    expect(existsSync(inFlightPath(dataDir))).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('the new box')
  })
})

describe('an install nobody ever confirmed', () => {
  it('keeps a new build that is plainly running', () => {
    // Power cut after the swap, before confirmation. The box came up on the
    // new version — rolling that back would be the bug.
    const result = install()
    if (!result.ok) return
    expect(recoverInterruptedInstall(dataDir, '0.18.0')).toEqual({
      action: 'confirmed',
      toVersion: '0.18.0',
    })
    expect(readFileSync(target, 'utf8')).toBe('the new box')
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(false)
  })

  it('finishes the rollback when the old build came back up', () => {
    const result = install()
    if (!result.ok) return
    const outcome = recoverInterruptedInstall(dataDir, '0.17.1')
    expect(outcome).toMatchObject({ action: 'rolled-back' })
    expect(readFileSync(target, 'utf8')).toBe('the old box')
  })

  it('refuses to guess when the running version is neither', () => {
    const result = install()
    if (!result.ok) return
    const outcome = recoverInterruptedInstall(dataDir, '0.16.0')
    expect(outcome).toMatchObject({ action: 'failed' })
    // Nothing touched: a box nobody can reason about is one to leave alone.
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(true)
  })

  it('does nothing at all when no install was in flight', () => {
    expect(recoverInterruptedInstall(dataDir, '0.17.1')).toEqual({ action: 'none' })
  })

  it('tolerates a marker that is junk', () => {
    writeFileSync(inFlightPath(dataDir), 'not json')
    expect(readInFlight(dataDir)).toBeNull()
    expect(recoverInterruptedInstall(dataDir, '0.17.1')).toEqual({ action: 'none' })
  })

  it('tolerates a marker missing the fields it needs', () => {
    writeFileSync(inFlightPath(dataDir), JSON.stringify({ toVersion: '0.18.0' }))
    expect(readInFlight(dataDir)).toBeNull()
  })

  it('round-trips a marker', () => {
    const marker: InFlight = {
      fromVersion: '0.17.1',
      toVersion: '0.18.0',
      targetPath: target,
      backupPath: `${target}${OLD_SUFFIX}`,
      snapshotPath: '/data/snapshots/crewbox-0.17.1-1.db',
      startedAt: 1_700_000_000_000,
    }
    writeInFlight(dataDir, marker)
    expect(readInFlight(dataDir)).toEqual(marker)
    clearInFlight(dataDir)
    expect(readInFlight(dataDir)).toBeNull()
  })
})

describe('sweeping up', () => {
  it('removes the previous binary once nothing needs it', () => {
    // Windows cannot delete its own running image, so the old one survives
    // until a later start clears it.
    writeFileSync(`${target}${OLD_SUFFIX}`, 'last week')
    expect(sweepOldBinaries(dataDir, target)).toEqual([`${target}${OLD_SUFFIX}`])
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(false)
  })

  it('will not touch the backup while an install is in flight', () => {
    // That `.old` is the only way back. Sweeping it here would turn a
    // recoverable failure into a permanent one.
    const result = install()
    if (!result.ok) return
    expect(sweepOldBinaries(dataDir, target)).toEqual([])
    expect(existsSync(`${target}${OLD_SUFFIX}`)).toBe(true)
  })

  it('does not mind when there is nothing to sweep', () => {
    expect(sweepOldBinaries(dataDir, target)).toEqual([])
  })
})
