// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import type { RecordsPlugin } from '../server.ts'

/**
 * Document edits the box hasn't confirmed, as the apps keep them
 * (unsentEdits.ts).
 *
 * The relay here is a Y.Doc run as server/src/docs.ts runs a room, and each
 * socket to it holds every frame until the test lets it through, so what the
 * page knows at each point of a handshake is the test's to say. The sync
 * messages are y-protocols' own, read on the page as sync.ts has its
 * provider read them. The app's files are a map of folders, as in
 * unsent.test.ts, and each test is a page loaded afresh.
 */

type Edits = typeof import('./unsentEdits.ts')

const ROOM = 'timetable/event'
const SHEET = 'patch/sheet-a'

/** The app's files: a folder per event, a file per slot. */
function files(folders: Record<string, Record<string, string>> = {}) {
  const kept = new Map(
    Object.entries(folders).map(([id, slots]) => [id, new Map(Object.entries(slots))])
  )
  const app = {
    kept,
    /** Writes and removes throw: a full disk. */
    refusing: false,
    /** Each write and remove, as `write friday/doc-edits`. */
    calls: [] as string[],
    readAll: vi.fn<RecordsPlugin['readAll']>(async ({ slot }) => {
      const values: Record<string, string> = {}
      for (const [id, slots] of kept) {
        const value = slots.get(slot)
        if (value !== undefined) values[id] = value
      }
      return { values }
    }),
    write: vi.fn<RecordsPlugin['write']>(async ({ event, slot, value }) => {
      app.calls.push(`write ${event}/${slot}`)
      if (app.refusing) throw new Error('No space left on device')
      kept.set(event, (kept.get(event) ?? new Map<string, string>()).set(slot, value))
    }),
    remove: vi.fn<RecordsPlugin['remove']>(async ({ event, slot }) => {
      app.calls.push(`remove ${event}/${slot}`)
      if (app.refusing) throw new Error('No space left on device')
      if (slot) kept.get(event)?.delete(slot)
      else kept.delete(event)
    }),
  }
  return app
}

type Files = ReturnType<typeof files>

/** The rooms an event's slot keeps edits for. */
function keptRooms(app: Files, event = 'friday'): string[] {
  const text = app.kept.get(event)?.get('doc-edits')
  return text === undefined ? [] : Object.keys(JSON.parse(text) as object).sort()
}

/** What the app's files keep of a room, as the update they hold. */
function keptOf(app: Files, room = ROOM, event = 'friday'): Uint8Array | undefined {
  const text = app.kept.get(event)?.get('doc-edits')
  const saved = text && (JSON.parse(text) as Record<string, { update: string }>)[room]
  return saved ? Uint8Array.from(atob(saved.update), (c) => c.charCodeAt(0)) : undefined
}

/** A document holding nothing but the updates given. */
function docOf(...updates: Uint8Array[]): Y.Doc {
  const doc = new Y.Doc()
  for (const update of updates) Y.applyUpdate(doc, update)
  return doc
}

const acts = (doc: Y.Doc) => doc.getMap<string>('acts').toJSON()

/** A sync message as y-websocket frames it, after its own message type. */
function frame(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  write(encoder)
  return encoding.toUint8Array(encoder)
}

/** A room on the box, as server/src/docs.ts runs one. */
class Relay {
  doc = new Y.Doc()
  links = new Set<Link>()
  constructor() {
    // Each change it takes goes to everybody in the room, the sender too.
    this.doc.on('update', (update: Uint8Array) => {
      for (const link of this.links) {
        link.toPhone.push(frame((encoder) => syncProtocol.writeUpdate(encoder, update)))
      }
    })
  }
}

/**
 * A room's socket, as y-websocket runs it on the page and server/src/docs.ts
 * on the box, with each frame held until the test lets it through.
 */
class Link {
  toPhone: Uint8Array[] = []
  toRelay: Uint8Array[] = []
  synced = false

  constructor(
    readonly edits: Edits,
    readonly relay: Relay,
    readonly doc: Y.Doc,
    readonly room = ROOM
  ) {
    relay.links.add(this)
    // The relay's handshake goes as it takes the socket, the page's as it opens.
    this.toPhone.push(frame((encoder) => syncProtocol.writeSyncStep1(encoder, relay.doc)))
    this.toRelay.push(frame((encoder) => syncProtocol.writeSyncStep1(encoder, doc)))
    doc.on('update', this.send)
  }

  /** Every change but the relay's goes out, as y-websocket sends them. */
  private send = (update: Uint8Array, origin: unknown) => {
    if (origin !== this) {
      this.toRelay.push(frame((encoder) => syncProtocol.writeUpdate(encoder, update)))
    }
  }

  /** The page reads the next `count` frames the relay sent, or all of them. */
  phoneReads(count = Infinity) {
    for (let i = 0; i < count && this.toPhone.length > 0; i++) {
      const decoder = decoding.createDecoder(this.toPhone.shift()!)
      decoding.readVarUint(decoder)
      // As sync.ts wraps the provider's own reading.
      const heard = this.edits.readRelaySync(decoder.arr, decoder.pos)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0)
      const type = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this)
      if (encoding.length(encoder) > 1) this.toRelay.push(encoding.toUint8Array(encoder))
      if (type === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true
        this.edits.relayInStep(this.room, true)
      }
      if (heard) this.edits.heardFromRelay(this.room, heard)
    }
  }

  /** The relay reads everything the page has sent, in order. */
  relayReads() {
    while (this.toRelay.length > 0) {
      const decoder = decoding.createDecoder(this.toRelay.shift()!)
      decoding.readVarUint(decoder)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0)
      syncProtocol.readSyncMessage(decoder, encoder, this.relay.doc, this)
      if (encoding.length(encoder) > 1) this.toPhone.push(encoding.toUint8Array(encoder))
    }
  }

  /** Back and forth until neither side has anything left to say. */
  settle() {
    while (this.toPhone.length > 0 || this.toRelay.length > 0) {
      this.relayReads()
      this.phoneReads()
    }
  }

  /** The socket drops, with whatever was on its way either way. */
  drop() {
    this.relay.links.delete(this)
    this.doc.off('update', this.send)
    this.toPhone = []
    this.toRelay = []
    if (this.synced) this.edits.relayInStep(this.room, false)
    this.synced = false
  }
}

/** A page loaded afresh, which read the app's files at its start if it has any. */
async function page(app?: Files): Promise<Edits> {
  vi.resetModules()
  const edits = await import('./unsentEdits.ts')
  if (app) expect(await edits.loadKeptEdits(app)).toBe(true)
  return edits
}

/** An open document, as the docs store opens one: watched before it can sync. */
function open(edits: Edits, room = ROOM, doc = new Y.Doc()): Y.Doc {
  edits.watchEdits(room, doc)
  return doc
}

/** Let an edit settle, and every write queued run. */
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
const SETTLED = 1000

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  localStorage.setItem('crewbox:db-epoch', 'friday')
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('an edit made with no box', () => {
  it('is kept against what the relay last said it had, and let go of once the relay sends it back', async () => {
    const app = files()
    const edits = await page(app)
    const relay = new Relay()
    relay.doc.getMap('acts').set('a', 'Band A')
    const doc = open(edits)
    const first = new Link(edits, relay, doc)
    first.settle()
    first.drop()
    await settle(SETTLED)
    // Nothing the relay lacks, so nothing to write.
    expect(app.calls).toEqual([])

    doc.getMap('acts').set('b', 'Band B')
    await settle(SETTLED)
    expect(keptRooms(app)).toEqual([ROOM])
    // The edit and nothing the relay had.
    expect(acts(docOf(keptOf(app)!))).toEqual({ b: 'Band B' })

    // Back: the relay's handshake shows it lacks the edit, and its answer to
    // the page's comes before it takes the page's, so neither is enough.
    const second = new Link(edits, relay, doc)
    second.phoneReads(1)
    second.relayReads()
    second.phoneReads(1)
    await settle()
    expect(keptRooms(app)).toEqual([ROOM])
    expect(acts(relay.doc)).toEqual({ a: 'Band A', b: 'Band B' })

    // The relay sends it back, as it sends everybody every change it takes.
    second.phoneReads(1)
    await settle()
    expect(app.kept.get('friday')?.has('doc-edits')).toBe(false)
    expect(app.calls).toEqual(['write friday/doc-edits', 'remove friday/doc-edits'])
  })

  it('keeps a whole document made with no box, having no word from the relay at all', async () => {
    const app = files()
    const edits = await page(app)
    const doc = open(edits, SHEET)
    doc.getMap('acts').set('a', 'Band A')
    doc.getMap('acts').set('b', 'Band B')
    await settle(SETTLED)
    expect(acts(docOf(keptOf(app, SHEET)!))).toEqual({ a: 'Band A', b: 'Band B' })
  })

  it('keeps a deletion until the relay is seen to have made it too', async () => {
    const app = files()
    const edits = await page(app)
    const relay = new Relay()
    relay.doc.getMap('acts').set('a', 'Band A')
    relay.doc.getMap('acts').set('b', 'Band B')
    const doc = open(edits)
    const first = new Link(edits, relay, doc)
    first.settle()
    first.drop()

    doc.getMap('acts').delete('a')
    await settle(SETTLED)
    expect(keptRooms(app)).toEqual([ROOM])

    // Every insertion is the relay's already, so its handshake could look
    // like enough, and its answer carries every deletion but this one.
    const second = new Link(edits, relay, doc)
    second.phoneReads(1)
    second.relayReads()
    second.phoneReads(1)
    await settle()
    expect(keptRooms(app)).toEqual([ROOM])

    second.phoneReads()
    await settle()
    expect(keptRooms(app)).toEqual([])
    expect(acts(relay.doc)).toEqual({ b: 'Band B' })
  })

  it('keeps work brought across from another event, and nothing that came from elsewhere', async () => {
    const app = files()
    const edits = await page(app)
    // The page's own, loaded with it.
    const { MOVED_ORIGIN } = await import('./persistence.ts')
    const doc = open(edits, SHEET)
    const other = new Y.Doc()
    other.getMap('acts').set('m', 'Moved')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), MOVED_ORIGIN)
    await settle(SETTLED)
    expect(acts(docOf(keptOf(app, SHEET)!))).toEqual({ m: 'Moved' })

    // What the page's own storage gives back as a document opens.
    const stored = new Y.Doc()
    stored.getMap('acts').set('s', 'Stored')
    const quiet = open(edits)
    Y.applyUpdate(quiet, Y.encodeStateAsUpdate(stored), { from: 'IndexedDB' })
    await settle(SETTLED)
    expect(keptRooms(app)).toEqual([SHEET])
  })

  it('is written once for a burst of typing, a second after it starts', async () => {
    const app = files()
    const edits = await page(app)
    const doc = open(edits)
    const text = doc.getText('notes')
    for (const letter of 'Stage left') text.insert(text.length, letter)
    await settle(SETTLED - 1)
    expect(app.calls).toEqual([])
    await settle(1)
    expect(app.calls).toEqual(['write friday/doc-edits'])
    expect(docOf(keptOf(app)!).getText('notes').toString()).toBe('Stage left')
  })

  it('is kept at once as the app goes into the background', async () => {
    const app = files()
    const edits = await page(app)
    const doc = open(edits)
    doc.getMap('acts').set('a', 'Band A')
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    hidden.mockRestore()
    await settle()
    expect(keptRooms(app)).toEqual([ROOM])
  })

  it('is kept at once as its document closes, while it can still be read', async () => {
    const app = files()
    const edits = await page(app)
    const doc = open(edits, SHEET)
    doc.getMap('acts').set('a', 'Band A')
    edits.unwatchEdits(SHEET)
    doc.destroy()
    await settle()
    expect(keptRooms(app)).toEqual([SHEET])
    // And nothing more comes of it.
    await settle(SETTLED)
    expect(app.calls).toEqual(['write friday/doc-edits'])
  })
})

describe('an edit made in step with the relay', () => {
  it('is left to the relay, which sends it straight back', async () => {
    const app = files()
    const edits = await page(app)
    const relay = new Relay()
    const doc = open(edits)
    const link = new Link(edits, relay, doc)
    link.settle()
    doc.getMap('acts').set('a', 'Band A')
    // Not even before it comes back.
    await settle(SETTLED)
    expect(app.calls).toEqual([])
    link.settle()
    await settle(SETTLED)
    expect(app.calls).toEqual([])
    expect(acts(relay.doc)).toEqual({ a: 'Band A' })
  })

  it('is kept if the socket drops before the relay sends it back', async () => {
    const app = files()
    const edits = await page(app)
    const relay = new Relay()
    relay.doc.getMap('acts').set('a', 'Band A')
    const doc = open(edits)
    const first = new Link(edits, relay, doc)
    first.settle()
    doc.getMap('acts').set('b', 'Band B')
    first.drop()
    await settle()
    expect(acts(docOf(keptOf(app)!))).toEqual({ b: 'Band B' })
    expect(acts(relay.doc)).toEqual({ a: 'Band A' })

    const second = new Link(edits, relay, doc)
    second.settle()
    await settle()
    expect(keptRooms(app)).toEqual([])
    expect(acts(relay.doc)).toEqual({ a: 'Band A', b: 'Band B' })
  })

  it('starts again from what the relay says at each handshake, since a box can come back without something', async () => {
    const app = files()
    const edits = await page(app)
    const relay = new Relay()
    const doc = open(edits)
    const link = new Link(edits, relay, doc)
    link.settle()
    doc.getMap('acts').set('b', 'Band B')
    link.settle()
    link.drop()
    await settle(SETTLED)
    expect(app.calls).toEqual([])

    // The same event's box, restored from before it had the edit.
    const restored = new Relay()
    const back = new Link(edits, restored, doc)
    back.phoneReads(1)
    back.drop()
    doc.getMap('acts').set('c', 'Band C')
    await settle(SETTLED)
    expect(acts(docOf(keptOf(app)!))).toEqual({ b: 'Band B', c: 'Band C' })
  })

  it('takes nothing the relay sends past a gap as held', async () => {
    const app = files()
    const edits = await page(app)
    const relay = new Relay()
    const doc = open(edits)
    const link = new Link(edits, relay, doc)
    link.settle()
    link.drop()
    doc.getMap('acts').set('b', 'Band B')
    doc.getMap('acts').set('c', 'Band C')
    await settle(SETTLED)

    // The second edit without the first: a relay holds one like that back
    // until the first arrives, and may yet never have it.
    const again = new Link(edits, relay, doc)
    again.phoneReads(1)
    const first = new Map([[doc.clientID, 1]])
    const later = Y.diffUpdate(Y.encodeStateAsUpdate(doc), Y.encodeStateVector(first))
    edits.heardFromRelay(ROOM, { type: 2, payload: later })
    await settle()
    expect(acts(docOf(keptOf(app)!))).toEqual({ b: 'Band B', c: 'Band C' })
  })

  it('keeps more, not less, when the relay sends something it can’t read', async () => {
    const app = files()
    const edits = await page(app)
    const relay = new Relay()
    relay.doc.getMap('acts').set('a', 'Band A')
    const doc = open(edits)
    const link = new Link(edits, relay, doc)
    link.settle()
    edits.heardFromRelay(ROOM, { type: 2, payload: new Uint8Array([0xff, 0xff]) })
    doc.getMap('acts').set('b', 'Band B')
    link.drop()
    await settle()
    // Without the relay's state vector, the whole document.
    expect(acts(docOf(keptOf(app)!))).toEqual({ a: 'Band A', b: 'Band B' })
  })
})

describe('the next start', () => {
  it('puts kept edits back as the document opens after a wipe, and they go out at its first handshake', async () => {
    const app = files()
    const before = await page(app)
    const relay = new Relay()
    relay.doc.getMap('acts').set('a', 'Band A')
    const doc = open(before)
    const link = new Link(before, relay, doc)
    link.settle()
    link.drop()
    doc.getMap('acts').set('b', 'Band B')
    await settle(SETTLED)

    // The web view's storage went: the document opens with nothing of its own.
    const edits = await page(app)
    const fresh = open(edits)
    expect(acts(fresh)).toEqual({ b: 'Band B' })
    await settle(SETTLED)
    // Put back, not a new edit: nothing to write.
    expect(app.calls).toEqual(['write friday/doc-edits'])

    new Link(edits, relay, fresh).settle()
    await settle()
    expect(acts(relay.doc)).toEqual({ a: 'Band A', b: 'Band B' })
    expect(acts(fresh)).toEqual({ a: 'Band A', b: 'Band B' })
    expect(keptRooms(app)).toEqual([])
  })

  it('goes on keeping against what the relay last said, with no word from it yet', async () => {
    const app = files()
    const before = await page(app)
    const relay = new Relay()
    relay.doc.getMap('acts').set('a', 'Band A')
    const doc = open(before)
    const link = new Link(before, relay, doc)
    link.settle()
    link.drop()
    doc.getMap('acts').set('b', 'Band B')
    await settle(SETTLED)

    // No wipe this time: the page's storage gives the document back whole.
    const edits = await page(app)
    const again = open(edits, ROOM, docOf(Y.encodeStateAsUpdate(doc)))
    again.getMap('acts').set('c', 'Band C')
    await settle(SETTLED)
    expect(acts(docOf(keptOf(app)!))).toEqual({ b: 'Band B', c: 'Band C' })
  })

  it('writes nothing, and leaves the files as they are, when it couldn’t read them', async () => {
    const app = files({ friday: { 'doc-edits': '{}' } })
    app.readAll.mockReturnValue(new Promise(() => {}))
    vi.resetModules()
    const edits = await import('./unsentEdits.ts')
    const loading = edits.loadKeptEdits(app)
    await settle(5000)
    await expect(loading).resolves.toBe(false)
    expect(edits.keepsEditsInApp()).toBe(false)

    const doc = open(edits)
    doc.getMap('acts').set('a', 'Band A')
    edits.relayInStep(ROOM, false)
    edits.forgetEdits(ROOM)
    await edits.forgetAllEdits('saturday')
    await settle(SETTLED)
    expect(app.calls).toEqual([])
    expect(app.kept.get('friday')?.get('doc-edits')).toBe('{}')
  })

  it('passes over whatever in the files it can’t read', async () => {
    const good = new Y.Doc()
    good.getMap('acts').set('a', 'Band A')
    const saved = (update: Uint8Array) => ({
      sv: btoa(String.fromCharCode(...Y.encodeStateVector(new Map()))),
      update: btoa(String.fromCharCode(...update)),
    })
    const app = files({
      friday: {
        'doc-edits': JSON.stringify({
          [SHEET]: saved(Y.encodeStateAsUpdate(good)),
          [ROOM]: saved(new Uint8Array([0xff, 0xff, 0xff])),
          'patch/sheet-b': { sv: 'not base64!', update: 'AAAA' },
          'patch/sheet-c': 'text',
          'patch/sheet-d': null,
          // A state vector cut short: five clients promised, none there.
          'patch/sheet-e': { ...saved(Y.encodeStateAsUpdate(good)), sv: btoa('\x05') },
        }),
      },
      '../escape': { 'doc-edits': JSON.stringify({ [SHEET]: saved(Y.encodeStateAsUpdate(good)) }) },
      saturday: { 'doc-edits': 'not json' },
      sunday: { 'doc-edits': 'null' },
    })
    const edits = await page(app)
    expect(acts(open(edits, SHEET))).toEqual({ a: 'Band A' })
    expect(acts(open(edits))).toEqual({})
    expect(acts(open(edits, 'patch/sheet-b'))).toEqual({})
    expect(acts(open(edits, 'patch/sheet-e'))).toEqual({})
  })
})

describe('the app’s files', () => {
  it('keep an event’s edits in one slot, written whole', async () => {
    const app = files()
    const edits = await page(app)
    open(edits).getMap('acts').set('a', 'Band A')
    open(edits, SHEET).getMap('acts').set('b', 'Band B')
    await settle(SETTLED)
    expect(app.calls).toEqual(['write friday/doc-edits'])
    expect(keptRooms(app)).toEqual([SHEET, ROOM].sort())
  })

  it('are written again after a write that failed, with the next', async () => {
    const app = files()
    const edits = await page(app)
    app.refusing = true
    open(edits).getMap('acts').set('a', 'Band A')
    await settle(SETTLED)
    expect(keptRooms(app)).toEqual([])

    // Nothing new to keep, but the files still lack what was.
    app.refusing = false
    edits.relayInStep(ROOM, false)
    await settle()
    expect(keptRooms(app)).toEqual([ROOM])
  })

  it('let go of a deleted document’s edits, and all of a forgotten event’s', async () => {
    const app = files({ saturday: { 'doc-edits': '{}', event: '{}' } })
    const edits = await page(app)
    open(edits).getMap('acts').set('a', 'Band A')
    open(edits, SHEET).getMap('acts').set('b', 'Band B')
    await settle(SETTLED)

    edits.forgetEdits(SHEET)
    await settle()
    expect(keptRooms(app)).toEqual([ROOM])

    await edits.forgetAllEdits('saturday')
    expect(app.kept.get('saturday')).toEqual(new Map([['event', '{}']]))
    await edits.forgetAllEdits('../escape')
    expect(app.calls.at(-1)).toBe('remove saturday/doc-edits')
  })
})

describe('anywhere but the apps', () => {
  it('keeps nothing: the open page holds every edit', async () => {
    const edits = await page()
    const doc = open(edits)
    doc.getMap('acts').set('a', 'Band A')
    await settle(SETTLED)
    expect(edits.keepsEditsInApp()).toBe(false)
  })
})

describe('reading what the relay sends', () => {
  const doc = new Y.Doc()
  doc.getMap('acts').set('a', 'Band A')

  const read = (bytes: Uint8Array) => {
    const decoder = decoding.createDecoder(bytes)
    decoding.readVarUint(decoder)
    return { decoder, heard: readRelaySyncOf(bytes, decoder.pos) }
  }
  let readRelaySyncOf: Edits['readRelaySync']
  beforeEach(async () => {
    readRelaySyncOf = (await page()).readRelaySync
  })

  it('finds each of y-protocols’ sync messages, and leaves the frame where it was', () => {
    const step1 = read(frame((encoder) => syncProtocol.writeSyncStep1(encoder, doc)))
    expect(step1.heard).toEqual({ type: 0, payload: Y.encodeStateVector(doc) })
    expect(step1.decoder.pos).toBe(1)

    const whole = Y.encodeStateAsUpdate(doc)
    expect(read(frame((encoder) => syncProtocol.writeSyncStep2(encoder, doc))).heard).toEqual({
      type: 1,
      payload: whole,
    })
    expect(read(frame((encoder) => syncProtocol.writeUpdate(encoder, whole))).heard).toEqual({
      type: 2,
      payload: whole,
    })
  })

  it('reads nothing into a frame that is cut short or of another kind', () => {
    const update = frame((encoder) => syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc)))
    expect(read(update.subarray(0, update.length - 1)).heard).toBeNull()
    expect(readRelaySyncOf(new Uint8Array([0, 3, 0]), 1)).toBeNull()
    expect(readRelaySyncOf(new Uint8Array([0, 2]), 1)).toBeNull()
    expect(readRelaySyncOf(new Uint8Array([0, 2, ...Array<number>(9).fill(0xff), 1]), 1)).toBeNull()
  })
})
