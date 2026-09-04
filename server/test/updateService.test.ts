import { createHash, generateKeyPairSync, sign as signWith } from 'node:crypto'
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
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DownloadIo } from '../src/update/download.ts'
import type { RestartIo } from '../src/update/restart.ts'
import { inFlightPath } from '../src/update/install.ts'
import { listSnapshots, readPendingRestore, schemaVersion } from '../src/update/snapshot.ts'
import { UpdateService } from '../src/update/service.ts'

/**
 * The whole flow, end to end, against a real filesystem.
 *
 * The order under test is the safety: copy the database, swap the binary,
 * *then* let go of the port, then start the new box and watch it. Everything
 * before the port is released is reversible with nobody noticing; everything
 * after is why the old process stays alive to supervise.
 *
 * The two properties worth defending hardest — and both have a test that
 * fails if the order is shuffled — are that **the port is never released
 * before there is a working binary in place**, and that **a failed restart
 * leaves the box listening on the old build** rather than dead.
 */

const VERSION = 'v0.18.0'
const BODY = Buffer.from('a plausible new crewbox')
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const KEYS = [publicKey.export({ type: 'spki', format: 'pem' }) as string]
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex')

type Answer = Awaited<ReturnType<DownloadIo['fetch']>>

function releaseServer(asset: string, fetched: string[] = []): DownloadIo {
  const manifest = `${digest(BODY)}  ${asset}\n`
  const signature = signWith(null, Buffer.from(manifest, 'utf8'), privateKey).toString('base64')
  return {
    fetch: (url) => {
      fetched.push(url)
      const name = url.split('/').pop() ?? ''
      const body = name.endsWith('.sig')
        ? Buffer.from(signature)
        : name.startsWith('SHA256SUMS')
          ? Buffer.from(manifest)
          : BODY
      const answer: Answer = {
        ok: true,
        status: 200,
        text: () => Promise.resolve(body.toString('utf8')),
        arrayBuffer: () => Promise.resolve(Uint8Array.from(body).buffer as ArrayBuffer),
      }
      return Promise.resolve(answer)
    },
    now: () => 1_000,
  }
}

let dir: string
let dbPath: string
let target: string
/** Everything the service did to the outside world, in order. */
let events: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-flow-'))
  dbPath = join(dir, 'crewbox.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE notes (body TEXT)')
  db.prepare('INSERT INTO notes (body) VALUES (?)').run('a show log entry')
  db.close()
  target = join(dir, 'crewbox')
  writeFileSync(target, 'the old box')
  chmodSync(target, 0o755)
  mkdirSync(join(dir, 'updates'), { recursive: true })
  events = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A restart that reports whatever the test tells it to. */
function restartIo(answers: ({ ok: true; version: string } | null)[]): RestartIo {
  let clock = 0
  let asked = 0
  return {
    launch: () => {
      events.push('launch')
      return 4242
    },
    probe: () => Promise.resolve(answers[asked++] ?? null),
    kill: () => events.push('kill'),
    now: () => clock,
    sleep: (ms) => {
      clock += ms
      return Promise.resolve()
    },
  }
}

const service = (
  answers: ({ ok: true; version: string } | null)[],
  packaged = true,
  fetched: string[] = []
) =>
  new UpdateService({
    dataDir: dir,
    dbPath,
    currentVersion: '0.17.1',
    healthUrl: 'http://localhost:8787/api/health',
    releasePort: () => {
      events.push('releasePort')
      return Promise.resolve()
    },
    regainPort: () => {
      events.push('regainPort')
      return Promise.resolve()
    },
    exit: () => events.push('exit'),
    packaged,
    target: { kind: 'binary', path: target },
    keys: KEYS,
    downloadIo: releaseServer(`crewbox-linux-x64-${VERSION}`, fetched),
    restartIo: restartIo(answers),
    platform: 'linux',
    base: 'https://example.test',
  })

/**
 * Wait for the fire-and-forget download to land.
 *
 * Polls rather than sleeping a guessed interval: the download does real
 * filesystem writes and a real SHA-256, so how long it takes depends on what
 * else the suite is doing. A fixed sleep passes alone and fails in the full
 * run, which is the least useful kind of test.
 */
const settle = async (s: UpdateService) => {
  for (let i = 0; i < 500 && s.state().stage === 'downloading'; i++) {
    await new Promise((r) => setTimeout(r, 2))
  }
}

describe('downloading', () => {
  it('goes idle → downloading → ready', async () => {
    const s = service([])
    expect(s.state().stage).toBe('idle')
    expect(s.start(VERSION)).toEqual({ ok: true })
    expect(s.state().stage).toBe('downloading')
    await settle(s)
    const state = s.state()
    expect(state.stage).toBe('ready')
    expect(state.build?.sha256).toBe(digest(BODY))
  })

  it('returns before the download finishes', () => {
    // A route that awaited this would hold a request open for the length of
    // a 200 MB transfer over whatever the venue calls broadband.
    const s = service([])
    s.start(VERSION)
    expect(s.state().stage).toBe('downloading')
    expect(s.state().build).toBeNull()
  })

  it('refuses a second download while one is running', async () => {
    const s = service([])
    s.start(VERSION)
    expect(s.start(VERSION)).toMatchObject({ ok: false })
    await settle(s)
  })

  it('records why, rather than spinning, when the release cannot be verified', async () => {
    const s = new UpdateService({
      dataDir: dir,
      dbPath,
      currentVersion: '0.17.1',
      healthUrl: 'http://localhost:8787/api/health',
      releasePort: () => Promise.resolve(),
      regainPort: () => Promise.resolve(),
      exit: () => {},
      packaged: true,
      target: { kind: 'binary', path: target },
      keys: [], // trusts nothing
      downloadIo: releaseServer(`crewbox-linux-x64-${VERSION}`),
      restartIo: restartIo([]),
      platform: 'linux',
      base: 'https://example.test',
    })
    s.start(VERSION)
    await settle(s)
    expect(s.state().stage).toBe('failed')
    expect(s.state().error).toContain('trusts no release keys')
  })
})

describe('what a box from source is told', () => {
  it('says so plainly, and offers no button', () => {
    const s = service([], false)
    const state = s.state()
    expect(state.canInstall).toBe(false)
    expect(state.blocked).toContain('from source')
    expect(s.start(VERSION)).toMatchObject({ ok: false })
  })
})

describe('installing', () => {
  const ready = async (answers: ({ ok: true; version: string } | null)[]) => {
    const s = service(answers)
    s.start(VERSION)
    await settle(s)
    return s
  }

  it('copies the database before it touches the binary', async () => {
    // Migrations are forward-only, so a rollback without a snapshot puts an
    // old binary in front of a schema it does not understand.
    const s = await ready([{ ok: true, version: '0.18.0' }])
    await s.install()
    const snapshots = listSnapshots(dir)
    expect(snapshots.length).toBe(1)
    expect(snapshots[0]!.version).toBe('0.17.1')
  })

  it('takes a snapshot the old build could actually read', async () => {
    const s = await ready([{ ok: true, version: '0.18.0' }])
    await s.install()
    const db = new DatabaseSync(listSnapshots(dir)[0]!.path, { readOnly: true })
    try {
      expect(db.prepare('SELECT body FROM notes').all()).toEqual([{ body: 'a show log entry' }])
    } finally {
      db.close()
    }
  })

  it('does not release the port until a working binary is in place', async () => {
    // The property that keeps a failed swap from taking the box off the air
    // for nothing.
    const s = await ready([{ ok: true, version: '0.18.0' }])
    await s.install()
    expect(events.indexOf('releasePort')).toBeLessThan(events.indexOf('launch'))
    expect(readFileSync(target, 'utf8')).toBe('a plausible new crewbox')
  })

  it('leaves once the new box is confirmed serving', async () => {
    const s = await ready([null, { ok: true, version: '0.18.0+abc' }])
    const result = await s.install()
    expect(result).toEqual({ ok: true })
    expect(events).toEqual(['releasePort', 'launch', 'exit'])
  })

  it('never releases the port at all when the swap fails', async () => {
    const s = await ready([{ ok: true, version: '0.18.0' }])
    rmSync(target) // nothing to replace
    const result = await s.install()
    expect(result).toMatchObject({ ok: false })
    expect(events).toEqual([])
  })

  it('refuses to install when nothing has been downloaded', async () => {
    const s = service([])
    expect(await s.install()).toMatchObject({ ok: false })
    expect(events).toEqual([])
  })
})

describe('when the new box will not come up', () => {
  it('puts the old one back and starts listening again', async () => {
    // The whole reason the *old* process supervises: it can still do this.
    const s = service([])
    s.start(VERSION)
    await settle(s)
    const result = await s.install()
    expect(result).toMatchObject({ ok: false })
    expect(events).toContain('regainPort')
    expect(readFileSync(target, 'utf8')).toBe('the old box')
  })

  it('says both what failed and that the old one is back', async () => {
    const s = service([])
    s.start(VERSION)
    await settle(s)
    const result = await s.install()
    // Asserted, not assumed. `if (result.ok) return` is a type guard, and a
    // regression that made the install succeed here would have skipped
    // every line below it and passed.
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.reason).toContain('did not answer')
    expect(result.reason).toContain('previous version has been put back')
  })

  it('writes down a database restore it cannot safely do itself', async () => {
    /**
     * The build got far enough to migrate and then died. The old box is now
     * serving a schema it does not understand — which does not crash and
     * does not announce itself — and it cannot fix that here: crew are
     * typing into that database and this process has it open, so replacing
     * the file would take whoever is on shift with it and, on POSIX, not
     * even change what this process goes on writing to. So it says so, and
     * the next start pays it.
     */
    let clock = 0
    const s = new UpdateService({
      dataDir: dir,
      dbPath,
      currentVersion: '0.17.1',
      healthUrl: 'http://localhost:8787/api/health',
      releasePort: () => Promise.resolve(),
      regainPort: () => Promise.resolve(),
      exit: () => {},
      packaged: true,
      target: { kind: 'binary', path: target },
      keys: KEYS,
      downloadIo: releaseServer(`crewbox-linux-x64-${VERSION}`),
      restartIo: {
        launch: () => 4242,
        probe: () => {
          // What the new build does on its way up, before it fails.
          const db = new DatabaseSync(dbPath)
          db.exec('PRAGMA user_version = 9')
          db.close()
          return Promise.resolve(null)
        },
        kill: () => {},
        // The clock has to move, or the probe deadline never arrives.
        now: () => clock,
        sleep: (ms) => {
          clock += ms
          return Promise.resolve()
        },
      },
      platform: 'linux',
      base: 'https://example.test',
    })
    s.start(VERSION)
    await settle(s)
    const result = await s.install()
    // Asserted, not assumed. `if (result.ok) return` is a type guard, and a
    // regression that made the install succeed here would have skipped
    // every line below it and passed.
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return

    expect(result.reason).toContain('RESTART THE BOX')
    const owed = readPendingRestore(dir)
    expect(owed).toMatchObject({ fromVersion: '0.17.1', toVersion: VERSION })
    expect(schemaVersion(owed!.snapshotPath)).toBe(0)
    // Not restored here — that is the next start's job, and this process
    // still has the database open.
    expect(schemaVersion(dbPath)).toBe(9)
  })

  it('owes nothing when the failed build never migrated', async () => {
    const s = service([])
    s.start(VERSION)
    await settle(s)
    const result = await s.install()
    // Asserted, not assumed. `if (result.ok) return` is a type guard, and a
    // regression that made the install succeed here would have skipped
    // every line below it and passed.
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.reason).toContain('never migrated')
    expect(readPendingRestore(dir)).toBeNull()
  })

  it('regains the port after rolling back, in that order', async () => {
    const s = service([])
    s.start(VERSION)
    await settle(s)
    await s.install()
    expect(events).toEqual(['releasePort', 'launch', 'kill', 'regainPort'])
  })

  it('leaves the failure readable in the state', async () => {
    const s = service([])
    s.start(VERSION)
    await settle(s)
    await s.install()
    expect(s.state().stage).toBe('failed')
    expect(s.state().error).toBeTruthy()
  })

  it('can install again after a rollback, without downloading again', async () => {
    // The swap moves the download into place, so a rollback that deleted the
    // installed file left "Try again" pointing at a file the install had
    // consumed — every retry another two hundred megabytes over a venue's
    // uplink, on a box that has just proved its uplink is what it is.
    const s = service([])
    s.start(VERSION)
    await settle(s)
    await s.install()
    expect(readFileSync(target, 'utf8')).toBe('the old box')
    s.reset()
    expect(s.state().stage).toBe('ready')

    events.length = 0
    const fetched: string[] = []
    const again = service([{ ok: true, version: '0.18.0' }], true, fetched)
    again.start(VERSION)
    await settle(again)
    // The manifest and its signature again — cheap, and they are what prove
    // the file on disk is still the right one — but not the build.
    expect(fetched.some((u) => u.endsWith(`crewbox-linux-x64-${VERSION}`))).toBe(false)
    expect(await again.install()).toEqual({ ok: true })
    expect(readFileSync(target, 'utf8')).toBe('a plausible new crewbox')
  })

  it('can be reset back to the verified build, without downloading again', async () => {
    const s = service([])
    s.start(VERSION)
    await settle(s)
    await s.install()
    s.reset()
    expect(s.state().stage).toBe('ready')
    expect(s.state().error).toBeNull()
  })
})

/**
 * The port itself refusing to come free.
 *
 * By the time `releasePort` is called the binary on disk is already the new
 * one, so a release that throws is not a tidy "sorry, try later": the box is
 * running a build it never launched, and the marker on disk says an install
 * is in flight. Nothing else is coming to fix that — `restartInto`, which
 * owns the other rollback, is never reached. So this path has to undo its own
 * work.
 */
describe('when the port will not come free', () => {
  const stuck = (answers: ({ ok: true; version: string } | null)[]) =>
    new UpdateService({
      dataDir: dir,
      dbPath,
      currentVersion: '0.17.1',
      healthUrl: 'http://localhost:8787/api/health',
      releasePort: () => {
        events.push('releasePort')
        return Promise.reject(new Error('the port was still busy after 5000 ms'))
      },
      regainPort: () => {
        events.push('regainPort')
        return Promise.resolve()
      },
      exit: () => events.push('exit'),
      packaged: true,
      target: { kind: 'binary', path: target },
      keys: KEYS,
      downloadIo: releaseServer(`crewbox-linux-x64-${VERSION}`),
      restartIo: restartIo(answers),
      platform: 'linux',
      base: 'https://example.test',
    })

  const readyStuck = async () => {
    const s = stuck([{ ok: true, version: '0.18.0' }])
    s.start(VERSION)
    await settle(s)
    return s
  }

  it('puts the old binary back rather than leaving the swap standing', async () => {
    const s = await readyStuck()
    expect(await s.install()).toMatchObject({ ok: false })
    expect(readFileSync(target, 'utf8')).toBe('the old box')
  })

  it('never launches the new build', async () => {
    // The point of failing here: a box that cannot free the port is a box the
    // new process could not bind on either.
    const s = await readyStuck()
    await s.install()
    expect(events).toEqual(['releasePort', 'regainPort'])
  })

  it('clears the in-flight marker, so the next boot does not roll back twice', async () => {
    const s = await readyStuck()
    await s.install()
    expect(existsSync(inFlightPath(dir))).toBe(false)
  })

  it('says what failed and that the old version is still in place', async () => {
    const s = await readyStuck()
    const result = await s.install()
    if (result.ok) throw new Error('the install should not have succeeded')
    expect(result.reason).toContain('still busy after 5000 ms')
    expect(result.reason).toContain('the previous version is still in place')
    expect(s.state().stage).toBe('failed')
  })
})
