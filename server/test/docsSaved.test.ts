import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { attachWs, buildApp, type App } from '../src/app.ts'
import { DocsRelay, type RelayLimits, type SavedDocs } from '../src/docs.ts'

/**
 * What the box saves of the documents it relays.
 *
 * The phones hold every document they have opened, and used to be the only
 * place one outlived a restart of the box: a crew member who joined after it
 * was told a sheet had been deleted until its author opened it again. The box
 * saves each one in its database now (docs.ts, `doc_updates`), and deletes it
 * from its disk when it is deleted.
 *
 * Each box here is a real app on a real database file, and a restart is a new
 * app on the same file. The failure cases drive the relay directly, with a
 * stand-in socket, because a failing disk is easier to arrange than to find.
 */

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-relay-saved-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const TEST_TIMEOUT = 20_000

interface Box {
  app: App
  store: Store
  db: DatabaseSync
  base: string
  token: string
  /** Stop as a box does: the relay saves what is waiting, then the database closes. */
  stop: () => Promise<void>
}

async function startBox(file: string, limits: Partial<RelayLimits> = {}): Promise<Box> {
  const db = openDb(join(dir, file))
  const store = new Store(db)
  const app = buildApp({
    store,
    eventPin: '9999',
    modules: ['chat', 'patch', 'lighting'],
    logger: false,
    relayLimits: limits,
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  attachWs(app)
  const address = app.server.address()
  const base = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  // The same name and PIN on every start, which on a restart signs back in.
  const joined = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name: 'Saved Tester', eventPin: '9999', personalPin: '1234' },
  })
  const token = (joined.json() as { token: string }).token
  return {
    app,
    store,
    db,
    base,
    token,
    stop: async () => {
      await app.close()
      db.close()
    },
  }
}

const provider = (box: Box, room: string, doc: Y.Doc): WebsocketProvider =>
  new WebsocketProvider(`${box.base}/ws/docs`, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    params: { token: box.token },
    disableBc: true,
  })

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The rows a box has saved for a room, read from its database. */
const rowsOf = (box: Box | Store, room: string): Uint8Array[] =>
  ('store' in box ? box.store : box).loadDoc(room).rows

const holds = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(text)

const titleOf = (doc: Y.Doc | null | undefined) => doc?.getMap('meta').get('title')

/** A device with a room open while `body` runs, gone (as far as the box can tell) after. */
async function withDevice<T>(
  box: Box,
  room: string,
  doc: Y.Doc,
  body: (prov: WebsocketProvider) => Promise<T>
): Promise<T> {
  const others = box.app.docs.stats().connections
  const prov = provider(box, room, doc)
  try {
    return await body(prov)
  } finally {
    prov.destroy()
    await waitFor(() => box.app.docs.stats().connections === others)
  }
}

/** A device writes a document, makes sure the box has it, and leaves. */
async function writeAndLeave(box: Box, room: string, title: string, body = ''): Promise<void> {
  const doc = new Y.Doc()
  doc.getMap('meta').set('title', title)
  if (body) doc.getText('body').insert(0, body)
  await withDevice(box, room, doc, () => waitFor(() => titleOf(box.app.docs.peek(room)) === title))
}

/** What a device that has never had this document is given by the box. */
async function openAsNewcomer(box: Box, room: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  await withDevice(box, room, doc, (prov) => waitFor(() => prov.synced))
  return doc
}

describe('a box that restarts', { timeout: TEST_TIMEOUT }, () => {
  it('still has a document for somebody who opens it after', async () => {
    const first = await startBox('restart.db')
    await writeAndLeave(first, 'patch/sheet-rider', 'Main Stage Rider')
    await first.stop()

    const second = await startBox('restart.db')
    const writes = [vi.spyOn(second.store, 'appendDocs'), vi.spyOn(second.store, 'compactDoc')]
    try {
      expect(second.app.docs.stats().saved).toBe(1)
      expect(titleOf(await openAsNewcomer(second, 'patch/sheet-rider'))).toBe('Main Stage Rider')
      // Reading it back wrote nothing.
      for (const write of writes) expect(write).not.toHaveBeenCalled()
    } finally {
      await second.stop()
    }
  })

  it('saves as it goes, so a box that stops without shutting down still has it', async () => {
    const box = await startBox('cut.db', { saveEveryMs: 50 })
    const doc = new Y.Doc()
    doc.getMap('meta').set('title', 'Typed Before The Power Cut')
    const prov = provider(box, 'patch/sheet-cut', doc)
    try {
      // Saved while its device still has it open.
      await waitFor(() => rowsOf(box, 'patch/sheet-cut').length > 0)
      // The next box reads the same file with this one never told to stop.
      const next = await startBox('cut.db')
      try {
        const found = await openAsNewcomer(next, 'patch/sheet-cut')
        expect(titleOf(found)).toBe('Typed Before The Power Cut')
      } finally {
        await next.stop()
      }
    } finally {
      prov.destroy()
      await waitFor(() => box.app.docs.stats().connections === 0)
      await box.stop()
    }
  })

  it('saves what was still waiting when it shuts down', async () => {
    // The next save is a minute away, so only shutting down can save this.
    const box = await startBox('shutdown.db', { saveEveryMs: 60_000 })
    const doc = new Y.Doc()
    doc.getMap('meta').set('title', 'Changed At The Last Moment')
    const prov = provider(box, 'patch/sheet-late', doc)
    try {
      await waitFor(() => titleOf(box.app.docs.peek('patch/sheet-late')) !== undefined)
      expect(rowsOf(box, 'patch/sheet-late')).toHaveLength(0)
      // The relay's part of shutting down, with the device still there.
      box.app.docs.close()
      expect(rowsOf(box, 'patch/sheet-late').length).toBeGreaterThan(0)
    } finally {
      prov.destroy()
      await box.stop()
    }

    const next = await startBox('shutdown.db')
    try {
      const found = await openAsNewcomer(next, 'patch/sheet-late')
      expect(titleOf(found)).toBe('Changed At The Last Moment')
    } finally {
      await next.stop()
    }
  })
})

describe('what the box keeps on disk', { timeout: TEST_TIMEOUT }, () => {
  it('folds a document’s rows into one while it is open, and again when it is left', async () => {
    const box = await startBox('fold.db', { saveEveryMs: 5 })
    const room = 'patch/sheet-busy'
    const saves = vi.spyOn(box.store, 'appendDocs')
    const folds = vi.spyOn(box.store, 'compactDoc')
    const doc = new Y.Doc()
    try {
      await withDevice(box, room, doc, async (prov) => {
        await waitFor(() => prov.synced)
        // Something typed, saved, and taken out again.
        doc.getText('body').insert(0, 'dock door 4471')
        await waitFor(() => rowsOf(box, room).some((row) => holds(row, '4471')))
        doc.getText('body').delete(0, doc.getText('body').length)

        // Then one change after another, each its own save, until the rows
        // are folded while the device still has it open.
        let edits = 0
        while (folds.mock.calls.length === 0 && edits < 150) {
          const before = saves.mock.calls.length
          doc.getMap('meta').set('edits', ++edits)
          await waitFor(() => saves.mock.calls.length > before)
        }
        expect(folds).toHaveBeenCalled()
        expect(edits).toBeGreaterThan(90)
        expect(rowsOf(box, room).length).toBeLessThan(5)
        // The state it was folded into has nothing of what was taken out.
        expect(rowsOf(box, room).some((row) => holds(row, '4471'))).toBe(false)
        doc.getMap('meta').set('title', 'Busy Sheet')
        await waitFor(() => titleOf(box.app.docs.peek(room)) === 'Busy Sheet')
      })
      // Left: one row, with all of it.
      expect(rowsOf(box, room)).toHaveLength(1)
      const back = new Y.Doc()
      Y.applyUpdate(back, rowsOf(box, room)[0]!)
      expect(titleOf(back)).toBe('Busy Sheet')
      expect(back.getText('body').toString()).toBe('')
    } finally {
      await box.stop()
    }
  })

  it('keeps no more than its budget: the least recently saved goes first, never one somebody has open, and a module’s index last', async () => {
    const box = await startBox('budget.db', { saveBytes: 2500 })
    const kilobyte = 'x'.repeat(1000)
    try {
      await writeAndLeave(box, 'patch/index', 'Index')
      const held = new Y.Doc()
      held.getMap('meta').set('title', 'Held Open')
      held.getText('body').insert(0, kilobyte)
      await withDevice(box, 'patch/sheet-held', held, async () => {
        // Saved before the two below, so the least recently saved of all.
        await waitFor(() => rowsOf(box, 'patch/sheet-held').length > 0)
        await writeAndLeave(box, 'patch/sheet-first', 'First', kilobyte)
        await writeAndLeave(box, 'patch/sheet-second', 'Second', kilobyte)

        expect(box.app.docs.stats().savedBytes).toBeLessThanOrEqual(2500)
        expect(rowsOf(box, 'patch/sheet-held').length).toBeGreaterThan(0)
        expect(rowsOf(box, 'patch/sheet-first')).toHaveLength(0)
        expect(box.app.docs.peek('patch/sheet-first')).toBeNull()
        expect(rowsOf(box, 'patch/sheet-second').length).toBeGreaterThan(0)
        expect(rowsOf(box, 'patch/index').length).toBeGreaterThan(0)
      })
    } finally {
      await box.stop()
    }
  })
})

/** Everything in a box's database files, as bytes on disk. */
function databaseFiles(file: string): Buffer {
  const path = join(dir, file)
  const parts = [readFileSync(path)]
  if (existsSync(`${path}-wal`)) parts.push(readFileSync(`${path}-wal`))
  return Buffer.concat(parts)
}

describe('a deleted document', { timeout: TEST_TIMEOUT }, () => {
  it('is deleted from the box’s disk, leaving nothing of it in the database’s files', async () => {
    const box = await startBox('wipe.db', { saveEveryMs: 20 })
    const room = 'patch/sheet-confidential'
    try {
      // Long enough to run onto pages of its own, which is where what a
      // delete leaves behind would stay.
      const body = `dock code 8820-fox ${'x'.repeat(10_000)} gate code 5531-owl`
      await writeAndLeave(box, room, 'Confidential Rider', body)
      expect(rowsOf(box, room).length).toBeGreaterThan(0)

      const index = new Y.Doc()
      await withDevice(box, 'patch/index', index, async (prov) => {
        await waitFor(() => prov.synced)
        // The sheet's row in the list, and then its deletion, as
        // upsertIndexEntry and removeIndexEntry write them.
        index.transact(() => {
          const entry = new Y.Map<unknown>()
          index.getMap('sheets').set('confidential', entry)
          entry.set('title', 'Confidential Rider')
        })
        await waitFor(() =>
          rowsOf(box, 'patch/index').some((row) => holds(row, 'Confidential Rider'))
        )
        // In the database file itself, as they are once a box has run a
        // while, not only in its log.
        box.store.emptyDocLog()
        const file = readFileSync(join(dir, 'wipe.db'))
        for (const secret of ['8820-fox', '5531-owl', 'Confidential Rider']) {
          expect(file.includes(secret)).toBe(true)
        }

        index.transact(() => {
          index.getMap('sheets').delete('confidential')
          index.getMap('deleted').set('confidential', new Date().toISOString())
        })
        await waitFor(() => rowsOf(box, room).length === 0)
        expect(box.app.docs.peek(room)).toBeNull()
        // The index's own rows said what it was called. Folded, they do not.
        await waitFor(() =>
          rowsOf(box, 'patch/index').every((row) => !holds(row, 'Confidential Rider'))
        )
      })
      // Nor does anything in the database's files, once its log is emptied.
      await waitFor(() => {
        const files = databaseFiles('wipe.db')
        return ['8820-fox', '5531-owl', 'Confidential Rider'].every(
          (secret) => !files.includes(secret)
        )
      })
    } finally {
      await box.stop()
    }
  })

  it('goes from the disk when its deletion arrives, though nobody had it open', async () => {
    const first = await startBox('late-delete.db')
    await writeAndLeave(first, 'lighting/plot-old', 'Old Rig')
    await first.stop()

    const box = await startBox('late-delete.db')
    try {
      // Saved, and not in memory: nobody has asked for it since the restart.
      expect(rowsOf(box, 'lighting/plot-old').length).toBeGreaterThan(0)
      expect(box.app.docs.stats().kept).toBe(0)
      // A phone that deleted it while the box was off brings the index back.
      const index = new Y.Doc()
      index.getMap('deleted').set('old', new Date().toISOString())
      await withDevice(box, 'lighting/index', index, () =>
        waitFor(() => rowsOf(box, 'lighting/plot-old').length === 0)
      )
      expect(box.app.docs.peek('lighting/plot-old')).toBeNull()
    } finally {
      await box.stop()
    }
  })

  it('goes when the box starts, if a delete that failed left it behind', async () => {
    // What a delete that failed leaves: the document's rows, and an index
    // saying it is deleted.
    const db = openDb(join(dir, 'left.db'))
    const store = new Store(db)
    const plot = new Y.Doc()
    plot.getMap('meta').set('title', 'Left Behind')
    const index = new Y.Doc()
    index.getMap('deleted').set('left', new Date().toISOString())
    store.appendDocs(
      [
        { room: 'lighting/plot-left', data: Y.encodeStateAsUpdate(plot) },
        { room: 'lighting/index', data: Y.encodeStateAsUpdate(index) },
      ],
      Date.now()
    )
    db.close()

    const box = await startBox('left.db')
    try {
      expect(rowsOf(box, 'lighting/plot-left')).toHaveLength(0)
      expect(box.app.docs.peek('lighting/plot-left')).toBeNull()
      expect(rowsOf(box, 'lighting/index').length).toBeGreaterThan(0)
    } finally {
      await box.stop()
    }
  })

  it('is never saved again, even when a device that missed the deletion brings it back', async () => {
    const box = await startBox('undead.db', { saveEveryMs: 20 })
    try {
      const index = new Y.Doc()
      await withDevice(box, 'patch/index', index, async (indexProv) => {
        await waitFor(() => indexProv.synced)
        index.getMap('deleted').set('gone', new Date().toISOString())
        await waitFor(
          () => box.app.docs.peek('patch/index')?.getMap('deleted').has('gone') === true
        )

        // A phone that was out of signal when it was deleted, with it open.
        const stale = new Y.Doc()
        stale.getMap('meta').set('title', 'Deleted Elsewhere')
        await withDevice(box, 'patch/sheet-gone', stale, async () => {
          await waitFor(
            () => titleOf(box.app.docs.peek('patch/sheet-gone')) === 'Deleted Elsewhere'
          )
          // Several saves' worth.
          await sleep(150)
          expect(rowsOf(box, 'patch/sheet-gone')).toHaveLength(0)
        })
      })
      expect(rowsOf(box, 'patch/sheet-gone')).toHaveLength(0)
      expect(box.app.docs.peek('patch/sheet-gone')).toBeNull()
    } finally {
      await box.stop()
    }
  })
})

/**
 * Just enough of a `ws` socket for the relay: it sends what the relay says to
 * `sent`, and `emit('message')` is a frame from the device.
 */
class StandInSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  binaryType = 'nodebuffer'
  sent: Uint8Array[] = []
  send(data: Uint8Array) {
    this.sent.push(data)
  }
  close() {
    if (this.readyState !== this.OPEN) return
    this.readyState = 3
    this.emit('close')
  }
  terminate() {
    this.close()
  }
  ping() {}
}

/** A device's change to a document, as the frame y-websocket sends it. */
function sendChange(socket: StandInSocket, update: Uint8Array): void {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0) // a sync frame
  syncProtocol.writeUpdate(encoder, update)
  socket.emit('message', Buffer.from(encoding.toUint8Array(encoder)))
}

/** A phone's copy of a document, handing each change to `socket`. */
function phoneOn(socket: StandInSocket): Y.Doc {
  const doc = new Y.Doc()
  doc.on('update', (update: Uint8Array) => sendChange(socket, update))
  return doc
}

const connect = (relay: DocsRelay, socket: StandInSocket, room: string) =>
  relay.connect(socket as unknown as import('ws').WebSocket, room)

/** Everything saved for a room, read into a document. */
function savedCopy(store: Store, room: string): Y.Doc {
  const doc = new Y.Doc()
  const { rows } = store.loadDoc(room)
  if (rows.length > 0) Y.applyUpdate(doc, Y.mergeUpdates(rows))
  return doc
}

/**
 * A box's database that fails when told to: every write while `broken`, the
 * next `unreadable` reads and the next `undeletable` deletes. Counts the
 * writes it is asked for.
 */
function flakyDisk(store: Store) {
  const state = { broken: false, unreadable: 0, undeletable: 0, writes: 0 }
  const writing = () => {
    state.writes++
    if (state.broken) throw new Error('disk full')
  }
  const disk: SavedDocs = {
    savedDocs: () => store.savedDocs(),
    loadDoc: (room) => {
      if (state.unreadable > 0) {
        state.unreadable--
        throw new Error('I/O error')
      }
      return store.loadDoc(room)
    },
    appendDocs: (updates, at) => {
      writing()
      store.appendDocs(updates, at)
    },
    compactDoc: (room, doc, upTo, at) => {
      writing()
      store.compactDoc(room, doc, upTo, at)
    },
    wipeDocs: (rooms) => {
      if (state.undeletable > 0) {
        state.undeletable--
        throw new Error('I/O error')
      }
      store.wipeDocs(rooms)
    },
    emptyDocLog: () => store.emptyDocLog(),
  }
  return { disk, state }
}

describe('when the disk fails', () => {
  it('says so once, and saves the whole document once it works again', async () => {
    const store = new Store(openDb(':memory:'))
    const { disk, state } = flakyDisk(store)
    const warnings: string[] = []
    const relay = new DocsRelay({ saveEveryMs: 5 }, { disk, warn: (m) => warnings.push(m) })
    const socket = new StandInSocket()
    connect(relay, socket, 'patch/sheet-flaky')
    const phone = phoneOn(socket)
    const change = async (key: string, value: string) => {
      const before = state.writes
      phone.getMap('meta').set(key, value)
      await waitFor(() => state.writes > before)
    }
    try {
      state.broken = true
      await change('title', 'First Try')
      await change('stage', 'Main')
      // Two saves failed, and it said so once.
      expect(state.writes).toBe(2)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('disk full')
      expect(store.loadDoc('patch/sheet-flaky').rows).toHaveLength(0)

      state.broken = false
      await change('date', 'Saturday')
      // What failed to save is in what saved.
      const saved = savedCopy(store, 'patch/sheet-flaky').getMap('meta').toJSON()
      expect(saved).toEqual({ title: 'First Try', stage: 'Main', date: 'Saturday' })

      // Working again, so the next failure is news.
      state.broken = true
      await change('title', 'Second Try')
      expect(warnings).toHaveLength(2)
    } finally {
      relay.close()
    }
  })

  it('saves what failed to save when the box shuts down, though nothing has changed since', async () => {
    const store = new Store(openDb(':memory:'))
    const { disk, state } = flakyDisk(store)
    const relay = new DocsRelay({ saveEveryMs: 5 }, { disk })
    const socket = new StandInSocket()
    connect(relay, socket, 'patch/sheet-once')
    const phone = phoneOn(socket)
    state.broken = true
    phone.getMap('meta').set('title', 'The Only Change')
    await waitFor(() => state.writes === 1)
    state.broken = false
    relay.close()
    expect(titleOf(savedCopy(store, 'patch/sheet-once'))).toBe('The Only Change')
  })

  it('deletes a deleted document when somebody next opens it, if deleting it failed', () => {
    const store = new Store(openDb(':memory:'))
    const plot = new Y.Doc()
    plot.getMap('meta').set('title', 'Deleted Plot')
    store.appendDocs([{ room: 'lighting/plot-cut', data: Y.encodeStateAsUpdate(plot) }], Date.now())
    const { disk, state } = flakyDisk(store)
    const relay = new DocsRelay({ saveEveryMs: 5 }, { disk })
    try {
      // Its deletion arrives, and deleting it from the disk fails.
      state.undeletable = 1
      const indexSocket = new StandInSocket()
      connect(relay, indexSocket, 'lighting/index')
      phoneOn(indexSocket).getMap('deleted').set('cut', new Date().toISOString())
      expect(state.undeletable).toBe(0)
      expect(store.loadDoc('lighting/plot-cut').rows).toHaveLength(1)

      // Somebody follows an old link to it: they get nothing, and it goes.
      connect(relay, new StandInSocket(), 'lighting/plot-cut')
      expect(titleOf(relay.peek('lighting/plot-cut'))).toBeUndefined()
      expect(store.loadDoc('lighting/plot-cut').rows).toHaveLength(0)
    } finally {
      relay.close()
    }
  })

  it('deletes a deleted document when its last device leaves, if deleting it failed while it was open', () => {
    const store = new Store(openDb(':memory:'))
    const plot = new Y.Doc()
    plot.getMap('meta').set('title', 'Deleted While Open')
    store.appendDocs(
      [{ room: 'lighting/plot-open', data: Y.encodeStateAsUpdate(plot) }],
      Date.now()
    )
    const { disk, state } = flakyDisk(store)
    const relay = new DocsRelay({ saveEveryMs: 5 }, { disk })
    try {
      const socket = new StandInSocket()
      connect(relay, socket, 'lighting/plot-open')
      // Its deletion arrives while somebody has it open, and deleting it
      // from the disk fails.
      state.undeletable = 1
      const indexSocket = new StandInSocket()
      connect(relay, indexSocket, 'lighting/index')
      phoneOn(indexSocket).getMap('deleted').set('open', new Date().toISOString())
      expect(state.undeletable).toBe(0)
      expect(store.loadDoc('lighting/plot-open').rows).toHaveLength(1)

      socket.close()
      expect(store.loadDoc('lighting/plot-open').rows).toHaveLength(0)
    } finally {
      relay.close()
    }
  })

  it('deletes saved rows that will not read, rather than failing every time they are opened', () => {
    const store = new Store(openDb(':memory:'))
    store.appendDocs(
      [{ room: 'patch/sheet-garbled', data: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]) }],
      Date.now()
    )
    const warnings: string[] = []
    const relay = new DocsRelay({}, { disk: store, warn: (m) => warnings.push(m) })
    try {
      expect(relay.peek('patch/sheet-garbled')).toBeNull()
      expect(store.loadDoc('patch/sheet-garbled').rows).toHaveLength(0)
      expect(warnings).toHaveLength(1)
    } finally {
      relay.close()
    }
  })
})

describe('folding a document', () => {
  it('keeps what was saved before, even when reading it back had failed', async () => {
    // Saved before the box restarted, on a disk that fails the first read.
    const store = new Store(openDb(':memory:'))
    const room = 'patch/sheet-hiccup'
    const earlier = new Y.Doc()
    earlier.getMap('meta').set('title', 'Saved Before')
    store.appendDocs([{ room, data: Y.encodeStateAsUpdate(earlier) }], Date.now())
    const { disk, state } = flakyDisk(store)
    state.unreadable = 1
    const relay = new DocsRelay({ saveEveryMs: 5 }, { disk })
    const socket = new StandInSocket()
    connect(relay, socket, room)
    const phone = phoneOn(socket)
    try {
      // Somebody who has never had it opens it, and the box has nothing to
      // give them. What they add is saved.
      expect(titleOf(relay.peek(room))).toBeUndefined()
      phone.getMap('meta').set('stage', 'Added Since')
      await waitFor(() => store.loadDoc(room).rows.length === 2)
      // They leave, and its rows are folded into one.
      socket.close()
      expect(store.loadDoc(room).rows).toHaveLength(1)
      expect(savedCopy(store, room).getMap('meta').toJSON()).toEqual({
        title: 'Saved Before',
        stage: 'Added Since',
      })
    } finally {
      relay.close()
    }
  })
})
