import { describe, expect, it } from 'vitest'
import { installMacApp, relaunchCommand, type MacIo } from '../src/update/macapp.ts'

/**
 * Replacing a signed `.app` from the disk image.
 *
 * **None of this has run on a real Mac yet** — the sandbox has no macOS, no
 * hdiutil and no Gatekeeper. So these tests do the one thing that is worth
 * doing without hardware: pin the *order and content of the commands*, and
 * every branch of what happens when one of them fails. The sequence is the
 * part that is easy to get subtly wrong and impossible to notice — a `cp -R`
 * instead of a `ditto`, a verify before the copy but not after, a mount left
 * behind on the failure path.
 *
 * What they cannot tell us is whether hdiutil and spctl behave as documented.
 * That still needs one real Mac updating itself once.
 */

const APP = '/Applications/Crewbox.app'
const DMG = '/Users/colm/.crewbox/data/updates/Crewbox-v0.18.0.dmg'

interface Recorder extends MacIo {
  calls: string[]
  renames: [string, string][]
  removed: string[]
}

function fakeIo(overrides: { fails?: Record<string, string>; missing?: string[] } = {}): Recorder {
  const calls: string[] = []
  const renames: [string, string][] = []
  const removed: string[] = []
  return {
    calls,
    renames,
    removed,
    run: (command, args) => {
      const line = [command, ...args].join(' ')
      calls.push(line)
      for (const [needle, message] of Object.entries(overrides.fails ?? {})) {
        if (line.includes(needle)) {
          const err = new Error(`${command} failed`) as Error & { stderr: string }
          err.stderr = message
          throw err
        }
      }
      return ''
    },
    mkdtemp: () => '/tmp/crewbox-dmg-x',
    exists: (path) => !(overrides.missing ?? []).includes(path),
    writable: () => true,
    rename: (from, to) => {
      renames.push([from, to])
    },
    remove: (path) => {
      removed.push(path)
    },
  }
}

const install = (io: MacIo) => installMacApp({ appPath: APP, dmgPath: DMG, io })

describe('the happy path', () => {
  it('mounts, checks, copies, checks again, unmounts', () => {
    const io = fakeIo()
    const result = install(io)
    expect(result.ok).toBe(true)

    const verbs = io.calls.map((c) => c.split(' ')[0])
    expect(verbs).toEqual([
      'hdiutil', // attach
      'codesign', // check the image's copy
      'spctl',
      'ditto', // install it
      'codesign', // check the installed copy
      'spctl',
      'hdiutil', // detach
    ])
  })

  it('copies with ditto, never cp', () => {
    // cp -R silently drops the extended attributes a signature lives in,
    // producing a bundle that is byte-identical in every file and will not
    // launch. This is the single most consequential line in the module.
    const io = fakeIo()
    install(io)
    expect(
      io.calls.some((c) => c.startsWith('ditto /tmp/crewbox-dmg-x/Crewbox.app /Applications'))
    ).toBe(true)
    expect(io.calls.some((c) => c.startsWith('cp'))).toBe(false)
  })

  it('checks the installed app, not just the one on the image', () => {
    // A copy that damaged the signature passes every check made on the
    // mounted image. The check that matters is the app at its final path.
    const io = fakeIo()
    install(io)
    const after = io.calls.slice(io.calls.findIndex((c) => c.startsWith('ditto')))
    expect(after.some((c) => c === `codesign --verify --deep --strict ${APP}`)).toBe(true)
    expect(after.some((c) => c === `spctl --assess --type execute ${APP}`)).toBe(true)
  })

  it('mounts read-only and out of the way', () => {
    const io = fakeIo()
    install(io)
    expect(io.calls[0]).toContain('-readonly')
    expect(io.calls[0]).toContain('-nobrowse')
  })

  it('keeps the old app for a rollback', () => {
    const io = fakeIo()
    const result = install(io)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backupPath).toBe(`${APP}.old`)
    expect(io.renames).toContainEqual([APP, `${APP}.old`])
  })
})

describe('refusing to leave a broken app behind', () => {
  it('puts the old app back when the copy fails', () => {
    const io = fakeIo({ fails: { ditto: 'No space left on device' } })
    const result = install(io)
    expect(result).toMatchObject({ ok: false, stage: 'swap', rolledBack: true })
    expect(io.renames).toContainEqual([`${APP}.old`, APP])
  })

  it('puts the old app back when the installed copy fails Gatekeeper', () => {
    // The nightmare this exists to prevent: a bundle in place that macOS
    // will not launch, discovered by a double-click that explains nothing.
    const io = fakeIo({ fails: { [`spctl --assess --type execute ${APP}`]: 'rejected' } })
    const result = install(io)
    expect(result).toMatchObject({ ok: false, stage: 'reverify', rolledBack: true })
    expect(io.removed).toContain(APP)
    expect(io.renames).toContainEqual([`${APP}.old`, APP])
  })

  it('never touches the installed app when the image itself is bad', () => {
    const io = fakeIo({ fails: { 'codesign --verify --deep --strict /tmp': 'invalid signature' } })
    const result = install(io)
    expect(result).toMatchObject({ ok: false, stage: 'verify' })
    expect(io.renames).toEqual([])
    expect(io.calls.some((c) => c.startsWith('ditto'))).toBe(false)
  })

  it('says so plainly when the directory is not writable', () => {
    // Worth its own answer: this one is fixed by who runs the box, not by
    // retrying, and a rename error halfway through would not say that.
    const io = { ...fakeIo(), writable: () => false }
    const result = installMacApp({ appPath: APP, dmgPath: DMG, io })
    expect(result).toMatchObject({ ok: false, stage: 'permission' })
    if (result.ok) return
    expect(result.reason).toContain('not writable')
  })

  it('does not mount anything when the directory is not writable', () => {
    const io = { ...fakeIo(), writable: () => false } as Recorder
    installMacApp({ appPath: APP, dmgPath: DMG, io })
    expect(io.calls).toEqual([])
  })

  it('reports a disk image that will not open as a mount problem', () => {
    const io = fakeIo({ fails: { 'hdiutil attach': 'no mountable file systems' } })
    const result = install(io)
    expect(result).toMatchObject({ ok: false, stage: 'mount' })
    if (result.ok) return
    expect(result.reason).toContain('no mountable file systems')
  })

  it('notices an image with no app inside it', () => {
    const io = fakeIo({ missing: ['/tmp/crewbox-dmg-x/Crewbox.app'] })
    const result = install(io)
    expect(result).toMatchObject({ ok: false, stage: 'verify' })
  })
})

describe('always unmounting', () => {
  it('detaches after a success', () => {
    const io = fakeIo()
    install(io)
    expect(io.calls.at(-1)).toContain('hdiutil detach')
  })

  it('detaches after a failure too', () => {
    // A mount left behind outlives this process, holds the image open, and
    // makes the next attempt fail with a message pointing nowhere near the
    // cause.
    const io = fakeIo({ fails: { ditto: 'boom' } })
    install(io)
    expect(io.calls.filter((c) => c.includes('hdiutil detach')).length).toBe(1)
  })

  it('forces the unmount when a clean one will not go', () => {
    const io = fakeIo({ fails: { 'hdiutil detach /tmp/crewbox-dmg-x -quiet': 'busy' } })
    install(io)
    expect(io.calls.some((c) => c.includes('detach') && c.includes('-force'))).toBe(true)
  })

  it('does not try to unmount an image that never attached', () => {
    const io = fakeIo({ fails: { 'hdiutil attach': 'corrupt' } })
    install(io)
    expect(io.calls.some((c) => c.includes('detach'))).toBe(false)
  })
})

describe('starting it again', () => {
  it('goes through open, not the wrapper binary', () => {
    // The bundle's executable is the menu-bar wrapper. Launching it outside
    // LaunchServices gives a process with no menu bar, no Dock identity and
    // no way to quit it — the exact problem the wrapper exists to solve.
    expect(relaunchCommand(APP)).toEqual({ command: 'open', args: ['-n', APP] })
  })
})
