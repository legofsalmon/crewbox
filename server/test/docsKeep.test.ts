import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { attachWs, buildApp, type App } from '../src/app.ts'

/**
 * What the relay keeps once the last device has left a document.
 *
 * A device lets go of a document a few seconds after it stops looking at it,
 * and the relay used to free a document along with its last device. So a
 * sheet could only be reached while somebody had it open, and a crew member
 * who joined later and tapped it in the list was told it had been deleted.
 * The relay keeps documents now: in memory within a budget, longest-kept out
 * first, and saved on disk (docsSaved.test.ts), never an empty one and never
 * one its module's index says is deleted.
 *
 * The real budget is 16 MB. This runs against a small one, because the thing
 * worth proving is that it is kept to, not what the number is.
 */

let dir: string
let store: Store
let app: App
let wsBase: string
let token: string

const KEEP = 2500

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-relay-keep-'))
  store = new Store(openDb(join(dir, 'crewbox.db')))
  store.createChannel('general', 'public', '')
  app = buildApp({
    store,
    eventPin: '9999',
    modules: ['chat', 'patch', 'lighting'],
    logger: false,
    relayLimits: { keepBytes: KEEP },
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  attachWs(app)
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  wsBase = `ws://127.0.0.1:${port}`
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name: 'Keep Tester', eventPin: '9999', personalPin: '1234' },
  })
  token = (res.json() as { token: string }).token
})

afterAll(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

const provider = (room: string, doc: Y.Doc, base = wsBase, auth = token): WebsocketProvider =>
  new WebsocketProvider(`${base}/ws/docs`, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    params: { token: auth },
    disableBc: true,
  })

/**
 * Long enough for a test whose wait has failed to close its devices before
 * the next one starts, so a failure is reported where it happened rather
 * than again in every test after it.
 */
const TEST_TIMEOUT = 20_000

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** The title the box holds for a room, if it holds the room at all. */
const titleOnBox = (room: string) => app.docs.peek(room)?.getMap('meta').get('title')

/**
 * A device with a room open for as long as `body` runs, which leaves however
 * that ends, so one failing test does not leave a device behind for the next.
 * Returns once the box has seen it go.
 */
async function withDevice<T>(
  room: string,
  doc: Y.Doc,
  body: (prov: WebsocketProvider) => Promise<T>
): Promise<T> {
  const others = app.docs.stats().connections
  const prov = provider(room, doc)
  try {
    return await body(prov)
  } finally {
    prov.destroy()
    await waitFor(() => app.docs.stats().connections === others)
  }
}

/**
 * A device writes a document, makes sure the box has it, and leaves.
 * `body` pads it to a known size for the budget.
 */
async function writeAndLeave(room: string, title: string, body = ''): Promise<void> {
  const doc = new Y.Doc()
  doc.getMap('meta').set('title', title)
  if (body) doc.getText('body').insert(0, body)
  await withDevice(room, doc, () => waitFor(() => titleOnBox(room) === title))
}

/** What a device that has never had this document is given by the box. */
async function openAsNewcomer(room: string): Promise<string | undefined> {
  const doc = new Y.Doc()
  return withDevice(room, doc, async (prov) => {
    await waitFor(() => prov.synced)
    return doc.getMap('meta').get('title') as string | undefined
  })
}

describe('what the relay keeps for nobody in particular', { timeout: TEST_TIMEOUT }, () => {
  it('keeps a document after its last device leaves, for one that opens it later', async () => {
    await writeAndLeave('patch/sheet-kept', 'Main Stage')
    expect(app.docs.stats()).toMatchObject({ rooms: 0, connections: 0 })
    expect(app.docs.stats().kept).toBeGreaterThanOrEqual(1)
    expect(await openAsNewcomer('patch/sheet-kept')).toBe('Main Stage')
  })

  it('keeps nothing of a document with nothing in it', async () => {
    // What following a link to a sheet this box has never seen opens.
    expect(await openAsNewcomer('patch/sheet-nowhere')).toBeUndefined()
    expect(app.docs.peek('patch/sheet-nowhere')).toBeNull()
  })

  it('lets a kept document go the moment its index marks it deleted', async () => {
    await writeAndLeave('patch/sheet-binned', 'Old Rider')
    await writeAndLeave('patch/sheet-old-rider-2', 'Older Rider')
    expect(titleOnBox('patch/sheet-binned')).toBe('Old Rider')

    // The deleting device writes the tombstone into the module's index, the
    // way `removeIndexEntry` does.
    const index = new Y.Doc()
    await withDevice('patch/index', index, async (prov) => {
      await waitFor(() => prov.synced)
      index.getMap('deleted').set('binned', new Date().toISOString())
      await waitFor(() => app.docs.peek('patch/sheet-binned') === null)
      // A dash in the id does not hide it.
      index.getMap('deleted').set('old-rider-2', new Date().toISOString())
      await waitFor(() => app.docs.peek('patch/sheet-old-rider-2') === null)
    })

    // An old link to it opens nothing, so it cannot come back that way.
    expect(await openAsNewcomer('patch/sheet-binned')).toBeUndefined()
  })

  it('does not keep a document deleted while somebody still had it open', async () => {
    const index = new Y.Doc()
    await withDevice('lighting/index', index, async (indexProv) => {
      await waitFor(() => indexProv.synced)

      const doc = new Y.Doc()
      doc.getMap('meta').set('title', 'Tour Rig')
      await withDevice('lighting/plot-scrapped', doc, async () => {
        await waitFor(() => titleOnBox('lighting/plot-scrapped') === 'Tour Rig')
        index.getMap('deleted').set('scrapped', new Date().toISOString())
        await waitFor(
          () => app.docs.peek('lighting/index')?.getMap('deleted').has('scrapped') === true
        )
      })
      expect(app.docs.peek('lighting/plot-scrapped')).toBeNull()

      // Another module's document with the same id is not this one.
      await writeAndLeave('patch/sheet-scrapped', 'Same Id, Other Module')
      expect(titleOnBox('patch/sheet-scrapped')).toBe('Same Id, Other Module')
    })
  })

  it('stops counting a document as kept once somebody opens it again', async () => {
    await writeAndLeave('patch/sheet-reopened', 'Second Stage')
    const before = app.docs.stats()
    const doc = new Y.Doc()
    await withDevice('patch/sheet-reopened', doc, async () => {
      await waitFor(() => doc.getMap('meta').get('title') === 'Second Stage')
      expect(app.docs.stats()).toMatchObject({ rooms: before.rooms + 1, kept: before.kept - 1 })
    })
    expect(app.docs.stats().kept).toBe(before.kept)
  })

  it('keeps no more in memory than its budget, letting the longest-kept go first', async () => {
    // The module's index, kept before any of the sheets below.
    await writeAndLeave('patch/index', 'Index')
    // Three documents of about a kilobyte each, in a budget of two and a half.
    const kilobyte = 'x'.repeat(1000)
    await writeAndLeave('patch/sheet-first', 'First', kilobyte)
    await writeAndLeave('patch/sheet-second', 'Second', kilobyte)
    const reads = vi.spyOn(store, 'loadDoc')
    try {
      expect(titleOnBox('patch/sheet-first')).toBe('First')
      expect(reads).not.toHaveBeenCalled()

      await writeAndLeave('patch/sheet-third', 'Third', kilobyte)
      expect(app.docs.stats().keptBytes).toBeLessThanOrEqual(KEEP)
      // Saving the third read its own rows; only what the box is asked for
      // from here counts.
      reads.mockClear()
      // The index goes last, since it is what says which kept documents have
      // been deleted: still in memory, so not read from disk.
      expect(titleOnBox('patch/index')).toBe('Index')
      expect(reads).not.toHaveBeenCalled()
      // The longest-kept went from memory, and is still the box's to give:
      // read back from disk.
      expect(titleOnBox('patch/sheet-first')).toBe('First')
      expect(reads).toHaveBeenCalledWith('patch/sheet-first')
      expect(app.docs.stats().keptBytes).toBeLessThanOrEqual(KEEP)
    } finally {
      reads.mockRestore()
    }
  })
})

describe('a box shutting down', { timeout: TEST_TIMEOUT }, () => {
  it('saves everything, and lets go of it, kept or still open', async () => {
    // A box of its own, since its relay is shut down.
    const other = buildApp({
      store: new Store(openDb(join(dir, 'other.db'))),
      eventPin: '9999',
      modules: ['patch'],
      logger: false,
    })
    await other.listen({ port: 0, host: '127.0.0.1' })
    attachWs(other)
    const address = other.server.address()
    const base = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const joined = await other.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Shutdown Tester', eventPin: '9999', personalPin: '1234' },
    })
    const auth = (joined.json() as { token: string }).token
    const onOther = (room: string) => other.docs.peek(room)?.getMap('meta').get('title')

    const kept = new Y.Doc()
    kept.getMap('meta').set('title', 'Kept Until Now')
    const keptProv = provider('patch/sheet-kept', kept, base, auth)
    const open = new Y.Doc()
    open.getMap('meta').set('title', 'Open At Shutdown')
    const openProv = provider('patch/sheet-open', open, base, auth)
    try {
      await waitFor(() => onOther('patch/sheet-kept') === 'Kept Until Now')
      await waitFor(() => onOther('patch/sheet-open') === 'Open At Shutdown')
      keptProv.destroy()
      await waitFor(() => other.docs.stats().kept === 1)

      // The relay's part of shutting down. What was kept goes from memory at
      // once, and is not read back from disk on the way out.
      other.docs.close()
      expect(other.docs.peek('patch/sheet-kept')).toBeNull()
      expect(other.docs.stats().kept).toBe(0)

      // What was open goes when its device does, rather than being kept on
      // the way out with nothing left to let it go.
      openProv.destroy()
      await waitFor(() => other.docs.stats().connections === 0)
      expect(other.docs.stats()).toMatchObject({ rooms: 0, connections: 0, kept: 0, keptBytes: 0 })
      // Both are on disk for the box that comes next.
      expect(other.docs.stats().saved).toBe(2)
    } finally {
      keptProv.destroy()
      openProv.destroy()
      await other.close()
    }
  })
})
