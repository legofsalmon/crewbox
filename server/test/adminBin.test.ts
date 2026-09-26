import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { buildApp, type App } from '../src/app.ts'
import { hashPin } from '../src/auth.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'

/**
 * The bin in the admin panel. Any crew member can delete a sheet for
 * everybody; only an admin can bring it back or wipe it early.
 */

const EVENT_PIN = '9999'
const ADMIN_PASSWORD = 'let-me-in-please'

let dir: string
let store: Store
let app: App

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-bin-'))
  store = new Store(openDb(':memory:'))
  store.createChannel('general', 'public', 'Everyone')
  store.setSetting('adminPasswordHash', hashPin(ADMIN_PASSWORD))
  // What a deleted sheet leaves: its state in the bin, with its index row.
  const sheet = new Y.Doc()
  sheet.getMap('meta').set('title', 'FOH Patch')
  store.binDocs(
    [
      {
        room: 'patch/sheet-foh',
        entry: JSON.stringify({ title: 'FOH Patch' }),
        data: Y.encodeStateAsUpdate(sheet),
      },
    ],
    Date.now()
  )
  app = buildApp({ store, eventPin: EVENT_PIN, filesDir: dir, dataDir: dir, logger: false })
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
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

describe('the bin, from the admin panel', () => {
  it('is closed to crew who are not admins', async () => {
    const headers = { authorization: `Bearer ${await signIn('Sam')}` }
    expect((await app.inject({ url: '/api/admin/bin', headers })).statusCode).toBe(403)
    const restore = await app.inject({
      method: 'POST',
      url: '/api/admin/bin/restore',
      headers,
      payload: { room: 'patch/sheet-foh' },
    })
    expect(restore.statusCode).toBe(403)
    expect(store.listBin()).toHaveLength(1)
  })

  it('lists what is in it and restores it', async () => {
    const headers = await asAdmin()
    const list = await app.inject({ url: '/api/admin/bin', headers })
    expect(list.json()).toMatchObject({
      docs: [{ room: 'patch/sheet-foh', module: 'patch', title: 'FOH Patch' }],
    })
    const restore = await app.inject({
      method: 'POST',
      url: '/api/admin/bin/restore',
      headers,
      payload: { room: 'patch/sheet-foh' },
    })
    expect(restore.json()).toEqual({ ok: true, docs: [] })
    expect(app.docs.peek('patch/sheet-foh')?.getMap('meta').get('title')).toBe('FOH Patch')
    const again = await app.inject({
      method: 'POST',
      url: '/api/admin/bin/restore',
      headers,
      payload: { room: 'patch/sheet-foh' },
    })
    expect(again.statusCode).toBe(404)
  })

  it('wipes one early', async () => {
    const headers = await asAdmin()
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/bin/delete',
      headers,
      payload: { room: 'patch/sheet-foh' },
    })
    expect(res.json()).toEqual({ ok: true, docs: [] })
    expect(store.listBin()).toEqual([])
  })
})
