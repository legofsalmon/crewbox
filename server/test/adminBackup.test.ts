import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type App } from '../src/app.ts'
import { hashPin } from '../src/auth.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'

/** Backups from the admin panel: where they go, and one now. Admin only. */

const EVENT_PIN = '9999'
const ADMIN_PASSWORD = 'let-me-in-please'

let root: string
let dataDir: string
let app: App

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crewbox-admin-backup-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir)
  const store = new Store(openDb(join(dataDir, 'crewbox.db')))
  store.createChannel('general', 'public', 'Everyone')
  store.setSetting('adminPasswordHash', hashPin(ADMIN_PASSWORD))
  app = buildApp({ store, eventPin: EVENT_PIN, filesDir: dataDir, dataDir, logger: false })
})

afterEach(async () => {
  await app.close()
  rmSync(root, { recursive: true, force: true })
})

const signIn = async (name: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, eventPin: EVENT_PIN, personalPin: '1234' },
  })
  return (res.json() as { token: string }).token
}

const asAdmin = async (): Promise<Record<string, string>> => {
  const token = await signIn('Alex')
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/unlock',
    headers: { authorization: `Bearer ${token}` },
    payload: { password: ADMIN_PASSWORD },
  })
  const { adminToken } = res.json() as { adminToken: string }
  return { authorization: `Bearer ${token}`, 'x-admin-token': adminToken }
}

describe('backups, from the admin panel', () => {
  it('is closed to crew who are not admins', async () => {
    const headers = { authorization: `Bearer ${await signIn('Sam')}` }
    const run = await app.inject({ method: 'POST', url: '/api/admin/backup/run', headers })
    expect(run.statusCode).toBe(403)
  })

  it('takes a folder, refuses one that would not work, and backs up now', async () => {
    const headers = await asAdmin()
    const before = (await app.inject({ url: '/api/admin/backup', headers })).json()
    expect(before.backup).toMatchObject({
      chosen: false,
      dir: join(dataDir, 'backups'),
      last: null,
    })

    const relative = await app.inject({
      method: 'POST',
      url: '/api/admin/backup/folder',
      headers,
      payload: { dir: 'usb' },
    })
    expect(relative.statusCode).toBe(400)

    const stick = join(root, 'stick')
    const chosen = await app.inject({
      method: 'POST',
      url: '/api/admin/backup/folder',
      headers,
      payload: { dir: stick },
    })
    expect(chosen.json().backup).toMatchObject({ chosen: true, dir: stick })

    const run = await app.inject({ method: 'POST', url: '/api/admin/backup/run', headers })
    expect(run.statusCode).toBe(200)
    expect(run.json().backup.last.dest.startsWith(stick)).toBe(true)
  })
})
