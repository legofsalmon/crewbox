import { createHash, generateKeyPairSync, sign as signWith } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { buildApp, type App } from '../src/app.ts'
import { UpdateService } from '../src/update/service.ts'
import type { DownloadIo } from '../src/update/download.ts'
import type { RestartIo } from '../src/update/restart.ts'

/**
 * The HTTP surface of the updater, which is where the promise is kept.
 *
 * Two properties live here rather than in the panel.
 *
 * **Everything is an admin's.** Unlike the video module, where reading is the
 * crew's because a read is a read, even the download here spends the venue's
 * uplink and fills the box's disk — and the install takes every phone offline.
 * None of that is a crew member's decision.
 *
 * **No single request takes the box off the air.** Somebody with an admin
 * token and curl is the threat model; most of what follows is an attempt to
 * install in one call.
 */

const EVENT_PIN = '9999'
const ADMIN_PASSWORD = 'let-me-in'
const VERSION = 'v0.18.0'
const BODY = Buffer.from('a plausible new crewbox')
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const KEYS = [publicKey.export({ type: 'spki', format: 'pem' }) as string]
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex')

type Answer = Awaited<ReturnType<DownloadIo['fetch']>>

const downloadIo = (): DownloadIo => {
  const manifest = `${digest(BODY)}  crewbox-linux-x64-${VERSION}\n`
  const signature = signWith(null, Buffer.from(manifest, 'utf8'), privateKey).toString('base64')
  return {
    fetch: (url) => {
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

/** A restart that never comes good, so install() always returns to be asserted on. */
const restartIo = (): RestartIo => {
  let clock = 0
  return {
    launch: () => 4242,
    probe: () => Promise.resolve(null),
    kill: () => {},
    now: () => clock,
    sleep: (ms) => {
      clock += ms
      return Promise.resolve()
    },
  }
}

let dir: string
let db: DatabaseSync
let store: Store
let app: App
let updater: UpdateService
let released: number

const build = (packaged = true): App => {
  const target = pathJoin(dir, 'crewbox')
  writeFileSync(target, 'the old box')
  chmodSync(target, 0o755)
  mkdirSync(pathJoin(dir, 'updates'), { recursive: true })
  updater = new UpdateService({
    dataDir: dir,
    dbPath: pathJoin(dir, 'box.db'),
    currentVersion: '0.17.1',
    healthUrl: 'http://localhost:8787/api/health',
    releasePort: () => {
      released++
      return Promise.resolve()
    },
    regainPort: () => Promise.resolve(),
    exit: () => {},
    packaged,
    target: { kind: 'binary', path: target },
    keys: KEYS,
    downloadIo: downloadIo(),
    restartIo: restartIo(),
    platform: 'linux',
    base: 'https://example.test',
  })
  return buildApp({
    store,
    eventPin: EVENT_PIN,
    adminPassword: ADMIN_PASSWORD,
    updater,
    filesDir: dir,
    dataDir: dir,
    logger: false,
  })
}

beforeEach(() => {
  dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-upd-'))
  db = openDb(pathJoin(dir, 'box.db'))
  store = new Store(db)
  store.createChannel('general', 'public', 'Everyone')
  released = 0
  app = build()
})
afterEach(async () => {
  await app.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const join = async (name: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, eventPin: EVENT_PIN, personalPin: '1234' },
  })
  return (res.json() as { token: string }).token
}

const asAdmin = async (name = 'Alex'): Promise<{ token: string; adminToken: string }> => {
  const token = await join(name)
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/unlock',
    headers: { authorization: `Bearer ${token}` },
    payload: { password: ADMIN_PASSWORD },
  })
  return { token, adminToken: (res.json() as { adminToken: string }).adminToken }
}

const headers = (auth: { token: string; adminToken?: string }, confirm?: string) => ({
  authorization: `Bearer ${auth.token}`,
  ...(auth.adminToken ? { 'x-admin-token': auth.adminToken } : {}),
  ...(confirm ? { 'x-update-confirm': confirm } : {}),
})

/** Download and wait for it to verify. */
const downloaded = async (auth: { token: string; adminToken: string }) => {
  await app.inject({
    method: 'POST',
    url: '/api/admin/update/download',
    headers: headers(auth),
    payload: { version: VERSION },
  })
  for (let i = 0; i < 500 && updater.state().stage === 'downloading'; i++) {
    await new Promise((r) => setTimeout(r, 2))
  }
}

const arm = async (auth: { token: string; adminToken: string }, version = VERSION) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/update/intent',
    headers: headers(auth),
    payload: { version },
  })
  return res
}

describe('who may update the box', () => {
  it('turns away somebody with no session at all', async () => {
    for (const url of [
      '/api/admin/update/download',
      '/api/admin/update/intent',
      '/api/admin/update/install',
    ]) {
      const res = await app.inject({ method: 'POST', url, payload: { version: VERSION } })
      expect(res.statusCode).toBe(401)
    }
  })

  it('turns away a crew member without the admin password', async () => {
    // Even the download: it spends the venue's uplink and fills the disk.
    const token = await join('Sam')
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/update/download',
      headers: { authorization: `Bearer ${token}` },
      payload: { version: VERSION },
    })
    expect(res.statusCode).toBe(403)
    expect(updater.state().stage).toBe('idle')
  })

  it('offers nothing at all when the box has no updater', async () => {
    await app.close()
    app = buildApp({
      store,
      eventPin: EVENT_PIN,
      adminPassword: ADMIN_PASSWORD,
      filesDir: dir,
      dataDir: dir,
      logger: false,
    })
    const auth = await asAdmin()
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/update',
      headers: headers(auth),
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('no single request takes the box off the air', () => {
  it('refuses to install without a confirmation', async () => {
    const auth = await asAdmin()
    await downloaded(auth)
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/update/install',
      headers: headers(auth),
      payload: { version: VERSION },
    })
    expect(res.statusCode).toBe(428)
    expect(released).toBe(0)
  })

  it('refuses a made-up confirmation token', async () => {
    const auth = await asAdmin()
    await downloaded(auth)
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/update/install',
      headers: headers(auth, 'not-a-real-token'),
      payload: { version: VERSION },
    })
    expect(res.statusCode).toBe(428)
    expect(released).toBe(0)
  })

  it('will not let one admin spend another admin’s confirmation', async () => {
    const alex = await asAdmin('Alex')
    await downloaded(alex)
    const armed = (await arm(alex)).json() as { intent: { token: string } }
    const sam = await asAdmin('Sam')
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/update/install',
      headers: headers(sam, armed.intent.token),
      payload: { version: VERSION },
    })
    expect(res.statusCode).toBe(428)
    expect(released).toBe(0)
  })

  it('will not spend a confirmation on a different version', async () => {
    // Otherwise the warning somebody read described a different thing than
    // the one they authorised.
    const auth = await asAdmin()
    await downloaded(auth)
    const armed = (await arm(auth)).json() as { intent: { token: string } }
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/update/install',
      headers: headers(auth, armed.intent.token),
      payload: { version: 'v0.19.0' },
    })
    expect(res.statusCode).toBe(428)
    expect(released).toBe(0)
  })

  it('spends a confirmation once and no more', async () => {
    const auth = await asAdmin()
    await downloaded(auth)
    const armed = (await arm(auth)).json() as { intent: { token: string } }
    await app.inject({
      method: 'POST',
      url: '/api/admin/update/install',
      headers: headers(auth, armed.intent.token),
      payload: { version: VERSION },
    })
    const again = await app.inject({
      method: 'POST',
      url: '/api/admin/update/install',
      headers: headers(auth, armed.intent.token),
      payload: { version: VERSION },
    })
    expect(again.statusCode).toBe(428)
  })

  it('will not arm against a build that is not downloaded', async () => {
    const auth = await asAdmin()
    const res = await arm(auth)
    expect(res.statusCode).toBe(409)
  })
})

describe('what arming tells you', () => {
  it('describes what would be interrupted, and cannot refuse', async () => {
    const auth = await asAdmin()
    await downloaded(auth)
    const body = (await arm(auth)).json() as {
      intent: { token: string; version: string; interruption: { blocks: boolean; lines: string[] } }
    }
    expect(body.intent.version).toBe(VERSION)
    expect(body.intent.token).toBeTruthy()
    expect(body.intent.interruption.blocks).toBe(false)
    // Always says something about the outage, even on a quiet box.
    expect(body.intent.interruption.lines.at(-1)).toContain('restarts')
  })
})

describe('reading the state', () => {
  it('reports idle before anything is asked for', async () => {
    const auth = await asAdmin()
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/update',
      headers: headers(auth),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { flow: { stage: string; canInstall: boolean } }
    expect(body.flow.stage).toBe('idle')
    expect(body.flow.canInstall).toBe(true)
  })

  it('answers the download request before the download finishes', async () => {
    // 202, because the transfer outlives this request by a very long way.
    const auth = await asAdmin()
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/update/download',
      headers: headers(auth),
      payload: { version: VERSION },
    })
    expect(res.statusCode).toBe(202)
    expect(updater.state().stage).toBe('downloading')
    await downloaded(auth)
  })

  it('shows the verified build once it lands', async () => {
    const auth = await asAdmin()
    await downloaded(auth)
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/update',
      headers: headers(auth),
    })
    const body = res.json() as { flow: { stage: string; build: { sha256: string } | null } }
    expect(body.flow.stage).toBe('ready')
    expect(body.flow.build?.sha256).toBe(digest(BODY))
  })

  it('says a box from source cannot install, and refuses to try', async () => {
    await app.close()
    app = build(false)
    const auth = await asAdmin()
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/update',
      headers: headers(auth),
    })
    const body = res.json() as { flow: { canInstall: boolean; blocked: string | null } }
    expect(body.flow.canInstall).toBe(false)
    expect(body.flow.blocked).toContain('from source')

    const attempt = await app.inject({
      method: 'POST',
      url: '/api/admin/update/download',
      headers: headers(auth),
      payload: { version: VERSION },
    })
    expect(attempt.statusCode).toBe(409)
  })

  it('rejects a version that is not one', async () => {
    const auth = await asAdmin()
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/update/download',
      headers: headers(auth),
      payload: { version: '' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('after a failed install', () => {
  it('reports the failure and can be reset to try again', async () => {
    const auth = await asAdmin()
    await downloaded(auth)
    const armed = (await arm(auth)).json() as { intent: { token: string } }
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/update/install',
      headers: headers(auth, armed.intent.token),
      payload: { version: VERSION },
    })
    expect(res.statusCode).toBe(500)
    expect(updater.state().stage).toBe('failed')

    const reset = await app.inject({
      method: 'POST',
      url: '/api/admin/update/reset',
      headers: headers(auth),
    })
    expect(reset.statusCode).toBe(200)
    expect((reset.json() as { flow: { stage: string } }).flow.stage).toBe('ready')
  })
})
