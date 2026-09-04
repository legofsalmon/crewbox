import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { attachWs, buildApp, type App } from '../src/app.ts'

/**
 * What one crew member can make the relay do to everybody else.
 *
 * The relay applied whatever it was sent and broadcast the result to every
 * other device in the room, with no bound on either the size of a document
 * or the rate of frames. So any session could grow a sheet without limit and
 * have the box faithfully push every megabyte of it to every phone watching
 * — not even deliberately: a paste of a very large spreadsheet does it, and
 * the phones on the receiving end are the ones that suffer.
 *
 * The real caps are 8 MB and 300 frames per ten seconds. This runs against
 * small ones, because the thing worth proving is that a cap is enforced and
 * not what the number is.
 */

let dir: string
let app: App
let wsBase: string
let token: string

const CAP = 4096

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-relay-limits-'))
  const store = new Store(openDb(join(dir, 'crewbox.db')))
  store.createChannel('general', 'public', '')
  app = buildApp({
    store,
    eventPin: '9999',
    modules: ['chat', 'patch'],
    logger: false,
    relayLimits: { maxRoomBytes: CAP, frameLimit: 200, frameWindowMs: 10_000 },
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  attachWs(app)
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  wsBase = `ws://127.0.0.1:${port}`
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name: 'Relay Tester', eventPin: '9999', personalPin: '1234' },
  })
  token = (res.json() as { token: string }).token
})

afterAll(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A raw relay socket, so the frames are ours rather than a provider's. */
const open = (room: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${wsBase}/ws/docs/${encodeURIComponent(room)}?token=${encodeURIComponent(token)}`
    )
    ws.on('error', reject)
    ws.once('open', () => resolve(ws))
  })

const closed = (ws: WebSocket): Promise<number> =>
  new Promise((resolve) => ws.once('close', (code: number) => resolve(code)))

/** A sync-update frame carrying `doc`'s whole state. */
const syncFrame = (doc: Y.Doc): Buffer => {
  const update = Y.encodeStateAsUpdate(doc)
  // messageType 0 (sync), then sync-step 2 (update), then the payload — all
  // varint-length-prefixed, which for these sizes is one or more bytes.
  const varint = (n: number): number[] => {
    const out: number[] = []
    let value = n
    while (value > 127) {
      out.push(128 | (value & 127))
      value = Math.floor(value / 128)
    }
    out.push(value)
    return out
  }
  return Buffer.from([0, 2, ...varint(update.length), ...update])
}

describe('what the relay will carry', () => {
  it('stops a room growing past its cap', async () => {
    const ws = await open('patch/sheet-fat')
    // Registered before the first send: the close can land mid-loop, and a
    // listener attached afterwards would wait for an event that has been.
    const ended = closed(ws)
    const doc = new Y.Doc()
    const text = doc.getText('body')

    // Well past the cap in one document, sent as repeated whole-state syncs
    // the way a client catching up would.
    for (let i = 0; i < 20 && ws.readyState === ws.OPEN; i++) {
      text.insert(0, 'x'.repeat(1024))
      ws.send(syncFrame(doc))
      await new Promise((r) => setTimeout(r, 250))
    }

    // The measurement is taken at most every two seconds, so the room is
    // bounded at the cap plus a couple of seconds of growth rather than
    // exactly at it. What matters is that it stopped.
    expect(await ended).toBe(1009)
  }, 20_000)

  it('lets an ordinary document through untouched', async () => {
    const ws = await open('patch/sheet-small')
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'a normal patch sheet')
    ws.send(syncFrame(doc))
    await new Promise((r) => setTimeout(r, 200))
    expect(ws.readyState).toBe(ws.OPEN)
    ws.close()
  })

  it('stops one connection flooding the room', async () => {
    // The chat hub has always had a rate limit and the relay did not, so one
    // stuck client could loop updates at wire speed and have the box
    // multiply them by every phone in the room.
    const ws = await open('patch/sheet-loud')
    const ended = closed(ws)
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'hi')
    for (let i = 0; i < 400 && ws.readyState === ws.OPEN; i++) ws.send(syncFrame(doc))
    expect(await ended).toBe(1008)
  }, 10_000)
})
