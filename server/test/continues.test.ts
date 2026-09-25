import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { attachWs, buildApp, type App } from '../src/app.ts'
import { hashPin } from '../src/auth.ts'
import { CONTINUES_KEY, continuesOf } from '../src/continues.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'

/**
 * An admin saying which event this box carries on.
 *
 * A spare with no backup starts with a database of its own, and every phone
 * treats it as another event: nothing of the one they had goes to it. The
 * admin's answer is what lets phones holding that event offer to bring their
 * work across, so it has to reach them: in the config before sign-in, in the
 * welcome, and live to phones already on the box. Only an admin may give it.
 */

const EVENT_PIN = '9999'
const ADMIN_PASSWORD = 'let-me-in-please'
const OLD_EVENT = 'mf3k2a1b0c9d8e7f6g5h4'

let dir: string
let store: Store
let app: App

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-continues-'))
  store = new Store(openDb(':memory:'))
  store.createChannel('general', 'public', 'Everyone')
  store.setSetting('adminPasswordHash', hashPin(ADMIN_PASSWORD))
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
  expect(res.statusCode).toBe(200)
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

const patch = (headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: 'PATCH', url: '/api/admin/settings', headers, payload: payload as object })

const config = async () =>
  (await app.inject({ url: '/api/config' })).json() as { eventId: string; continues?: string }

describe('saying which event this box carries on', () => {
  it('tells phones before sign-in, and gives the admin panel its name back', async () => {
    const headers = await asAdmin()
    expect((await config()).continues).toBeUndefined()

    const res = await patch(headers, { continues: { id: OLD_EVENT, name: ' Ashton Court ' } })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { settings: { continues: unknown } }).settings.continues).toEqual({
      id: OLD_EVENT,
      name: 'Ashton Court',
    })
    // Phones need its ID and nothing else: the name is theirs already.
    expect((await config()).continues).toBe(OLD_EVENT)

    const settings = await app.inject({ url: '/api/admin/settings', headers })
    expect((settings.json() as { settings: { continues: unknown } }).settings.continues).toEqual({
      id: OLD_EVENT,
      name: 'Ashton Court',
    })
  })

  it('stops saying it once cleared', async () => {
    const headers = await asAdmin()
    await patch(headers, { continues: { id: OLD_EVENT, name: 'Ashton Court' } })
    const res = await patch(headers, { continues: null })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { settings: { continues: unknown } }).settings.continues).toBeNull()
    expect((await config()).continues).toBeUndefined()
  })

  it('leaves it as it was when a save is about something else', async () => {
    const headers = await asAdmin()
    await patch(headers, { continues: { id: OLD_EVENT, name: 'Ashton Court' } })
    expect((await patch(headers, { eventPin: '24682468' })).statusCode).toBe(200)
    expect((await config()).continues).toBe(OLD_EVENT)
  })

  it('refuses the event it is running, and anything that is not an event ID', async () => {
    const headers = await asAdmin()
    const own = (await config()).eventId
    for (const id of [own, '', 'has spaces', 'x'.repeat(65), '../../etc']) {
      const res = await patch(headers, { continues: { id, name: 'Somewhere' } })
      expect(res.statusCode, id).toBe(400)
    }
    const long = await patch(headers, { continues: { id: OLD_EVENT, name: 'n'.repeat(65) } })
    expect(long.statusCode).toBe(400)
    expect((await config()).continues).toBeUndefined()
    expect(store.getSetting(CONTINUES_KEY)).toBeUndefined()
  })

  it('takes it only from an admin', async () => {
    const crew = await signIn('Sam')
    const payload = { continues: { id: OLD_EVENT, name: 'Ashton Court' } }
    expect((await patch({}, payload)).statusCode).toBe(401)
    expect((await patch({ authorization: `Bearer ${crew}` }, payload)).statusCode).toBe(403)
    expect((await config()).continues).toBeUndefined()
  })

  it('reaches phones already on the box, and the next one to connect', async () => {
    const token = await signIn('Sam')
    await app.listen({ port: 0, host: '127.0.0.1' })
    attachWs(app)
    const port = (app.server.address() as { port: number }).port
    const connect = () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      const configs: Array<{ continues?: string }> = []
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; config?: { continues?: string } }
        if (msg.type === 'welcome' || msg.type === 'config') configs.push(msg.config ?? {})
      })
      ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', token, cursors: {} })))
      return { ws, configs }
    }
    const on = connect()
    await expect.poll(() => on.configs.length).toBe(1)
    expect(on.configs[0].continues).toBeUndefined()

    await patch(await asAdmin(), { continues: { id: OLD_EVENT, name: 'Ashton Court' } })
    await expect.poll(() => on.configs.at(-1)?.continues).toBe(OLD_EVENT)

    const next = connect()
    await expect.poll(() => next.configs[0]?.continues).toBe(OLD_EVENT)
    on.ws.close()
    next.ws.close()
  })
})

describe('what is kept', () => {
  it('reads junk in the setting as nothing said', () => {
    for (const junk of ['', 'not json', '{}', '{"id":"has spaces"}', '[]', 'null']) {
      store.setSetting(CONTINUES_KEY, junk)
      expect(continuesOf(store), junk).toBeNull()
    }
    store.setSetting(CONTINUES_KEY, JSON.stringify({ id: OLD_EVENT }))
    expect(continuesOf(store)).toEqual({ id: OLD_EVENT, name: '' })
  })
})
