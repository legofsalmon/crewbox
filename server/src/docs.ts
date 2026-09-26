import type { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

/**
 * Shared-docs relay: the second sync primitive next to the chat message log.
 * Speaks the standard y-websocket wire protocol (sync + awareness), so any
 * Yjs client connects unchanged; implemented directly on y-protocols rather
 * than y-websocket's server utils to pin the wire format deliberately and
 * avoid its unused LevelDB dependency tree.
 *
 * Every device keeps the documents it has opened, in IndexedDB, and gives
 * the box what it lacks on every connect (Live Patch's model, unchanged).
 * The box saves what it relays as well, in its database (`doc_updates`,
 * see `SavedDocs`), so a crew member who opens a document later gets it from
 * the box, whatever has happened to the box since. It holds a document in
 * memory while anyone has it open, and keeps it there a while after (see
 * `KEEP_BYTES`). A document its module's index marks deleted goes in the
 * box's bin for `BIN_MS`, where an admin can restore it, and is then wiped
 * from the box's disk. It is never saved again unless it is restored.
 */

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

/** A module's index room is `<module>/index`, and its tombstones live here. */
const INDEX_SUFFIX = '/index'
const TOMBSTONES = 'deleted'
/** An index's rows, by document id (web/src/lib/docs/indexDoc.ts: 'sheets' for every module). */
const ENTRIES = 'sheets'

/**
 * How long a deleted document stays in the bin.
 *
 * Any crew member can delete a sheet for everybody, and a wrong tap during a
 * changeover is found out at the next one, or the next morning. A week covers
 * a festival and the day after. After that it is wiped as a delete always
 * was, because a delete is still somebody's decision that the paperwork
 * should be gone.
 */
export const BIN_MS = 7 * 24 * 60 * 60_000

/** How often the bin is checked for documents past their week. */
const PURGE_EVERY_MS = 60 * 60_000

/** Origin of an admin's restore, so it is saved and broadcast like any change. */
const RESTORED = Symbol('restored')

/** A deleted document in the bin, as the admin panel lists it. */
export interface BinnedDoc {
  /** Its room, `<module>/<kind>-<id>`: what a restore names. */
  room: string
  module: string
  /** Its title when it was deleted, or '' when the box never saw its index row. */
  title: string
  deletedAt: number
  /** When it is wiped unless restored. */
  purgesAt: number
  bytes: number
}

const PING_INTERVAL_MS = 15_000

/** Origin of what a room is read back with from disk, which is saved already. */
const FROM_DISK = Symbol('from disk')

interface Room {
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  /** conn → awareness clientIds it controls (cleared when it drops). */
  conns: Map<WebSocket, Set<number>>
  /** Encoded size of the document, last time it was measured. */
  bytes: number
  /** When that was, so the measurement is not taken per frame. */
  measuredAt: number
  /** When the last device left it, while nobody has it open; null while somebody does. */
  keptSince: number | null
  /** What devices have changed since the last save. */
  pending: Uint8Array[]
  /**
   * The next save writes the whole document rather than what changed: a
   * save failed, so the saved copy may be missing a change, or its rows
   * hold something since deleted.
   */
  whole: boolean
  /** Its module's index says it has been deleted, so it is never saved again. */
  deleted: boolean
}

/**
 * How much state one shared document may hold.
 *
 * The relay applied whatever it was sent and broadcast the result to every
 * other device in the room, so any crew member with a session could grow a
 * sheet without bound — and the box would faithfully push every megabyte of
 * it to every phone watching. Not even deliberately: a paste of a very large
 * spreadsheet does it, and the phones on the receiving end are the ones that
 * suffer.
 *
 * Eight megabytes is far past any real document. The largest festival master
 * patch in the fixtures is under a hundred kilobytes encoded, and a plot with
 * a thousand fixtures and their GDTF modes is a few hundred.
 */
const MAX_ROOM_BYTES = 8 * 1024 * 1024

/**
 * How much of what nobody has open the box keeps in memory, in encoded bytes.
 *
 * A device lets go of a document a few seconds after it stops looking at it.
 * The box keeps it in memory for whoever opens it next, and once the total
 * passes this, lets the longest-kept go first (see `trimKept`). What it lets
 * go of is still saved, and is read back from disk when somebody opens it.
 *
 * A festival's paperwork is a few megabytes (a master patch is under a
 * hundred kilobytes encoded, a thousand-fixture plot a few hundred), so this
 * keeps all of it with room to spare. In memory a document takes ten to
 * seventeen times its encoded size (measured on synthetic sheets and plots),
 * so what is kept costs the box under three hundred megabytes at most, and a
 * box that has relayed a great many large plots cannot grow without bound.
 */
const KEEP_BYTES = 16 * 1024 * 1024

/**
 * How much the box saves, in encoded bytes, before it deletes the least
 * recently saved documents from disk.
 *
 * Four times what it keeps in memory and far past a festival's paperwork, so
 * no event should meet it. It is there so that a box which has relayed a
 * great many large plots cannot grow its database, and every backup of it,
 * without bound. A document let go this way is still on the devices that
 * have it, and is saved again the next time one of them opens it.
 */
const SAVE_BYTES = 64 * 1024 * 1024

/**
 * How long a change waits to be saved, so that a burst of typing is one row
 * rather than one per keystroke.
 *
 * It is also the most of a change a power cut can cost the box, and every
 * device that made the change still has it, and gives it back on its next
 * connect.
 */
const SAVE_EVERY_MS = 500

/**
 * How many rows a document may have on disk before they are folded into one.
 *
 * A save adds a row holding only what changed, which is cheap to write, and
 * reading a document back applies every row. Folding them into the
 * document's state also drops what was typed and then deleted, which the
 * rows hold and the state does not. A document is folded when its last
 * device leaves, too.
 */
const COMPACT_ROWS = 100

/** The encoded size of a document with nothing in it. */
const EMPTY_UPDATE_BYTES = 2

/**
 * How often the size is actually measured.
 *
 * `encodeStateAsUpdate` serialises the whole document, so doing it per frame
 * would cost more than the thing it is guarding against. Measuring every two
 * seconds bounds a room to the cap plus two seconds of growth, which is the
 * right trade: the point is that it stops, not the exact byte it stops at.
 */
const MEASURE_EVERY_MS = 2000

/**
 * Sync and awareness frames one connection may send in ten seconds.
 *
 * The chat hub has always had this and the relay did not, so one stuck or
 * hostile client could loop updates at wire speed and have the box multiply
 * them by every phone in the room. A whole-document sync is a handful of
 * frames and a fast typist emits a few a second, so this is far above any
 * real cadence.
 */
const FRAME_LIMIT = 300
const FRAME_WINDOW_MS = 10_000

/** What a relay will carry. Overridable so a test can use small numbers. */
export interface RelayLimits {
  maxRoomBytes: number
  frameLimit: number
  frameWindowMs: number
  keepBytes: number
  saveBytes: number
  saveEveryMs: number
}

/**
 * Where the relay saves documents: the box's database (`Store`). Each
 * document is rows of Yjs updates under its room name, which the relay reads
 * back and applies in any order, as Yjs allows.
 */
export interface SavedDocs {
  /** Every saved document, with its bytes and rows and when it was last saved. */
  savedDocs(): { room: string; bytes: number; rows: number; savedAt: number }[]
  /** A document's rows, and the last one read, for `compactDoc`. */
  loadDoc(room: string): { rows: Uint8Array[]; upTo: number }
  /** One row for each of several documents, all or none. */
  appendDocs(updates: { room: string; data: Uint8Array }[], at: number): void
  /** Replace the rows read up to `upTo` with one. */
  compactDoc(room: string, state: Uint8Array, upTo: number, at: number): void
  /** Delete documents, overwriting what they held. */
  wipeDocs(rooms: string[]): void
  /** Empty the write-ahead log, which can still hold what a delete overwrote. */
  emptyDocLog(): void
  /** Put deleted documents in the bin; one already there keeps its first copy. */
  binDocs(docs: { room: string; entry: string; data: Uint8Array }[], at: number): void
  /** What is in the bin. */
  listBin(): { room: string; entry: string; bytes: number; deletedAt: number }[]
  /** One binned document. */
  loadBin(room: string): { entry: string; data: Uint8Array; deletedAt: number } | null
  /** Take documents out of the bin, overwriting what they held. */
  unbinDocs(rooms: string[]): void
}

interface Saved {
  bytes: number
  rows: number
  savedAt: number
}

export class DocsRelay {
  private rooms = new Map<string, Room>()
  private heartbeat: NodeJS.Timeout
  private alive = new WeakSet<WebSocket>()
  private limits: RelayLimits
  /** Shut down: nothing is kept from here on. */
  private closed = false
  /** Where documents are saved. None, and the relay keeps them in memory only. */
  private disk: SavedDocs | undefined
  /** What is saved, by room. */
  private saved = new Map<string, Saved>()
  /** Rooms with something for the next save. */
  private dirty = new Set<string>()
  private saveTimer: NodeJS.Timeout | null = null
  /** Something was deleted, so the next save empties the database's log. */
  private emptyLog = false
  private warn: (message: string) => void
  /** Saving has failed and been said so. Quiet until something works. */
  private failing = false
  /**
   * Each module's index rows as last seen, by module then document id. Rows
   * are added and updated here but never removed, so the row of a document
   * just deleted is still here to go in the bin with it.
   */
  private entries = new Map<string, Map<string, Record<string, string>>>()
  private purgeTimer: NodeJS.Timeout | null = null

  constructor(
    limits: Partial<RelayLimits> = {},
    options: { disk?: SavedDocs; warn?: (message: string) => void } = {}
  ) {
    this.limits = {
      maxRoomBytes: limits.maxRoomBytes ?? MAX_ROOM_BYTES,
      frameLimit: limits.frameLimit ?? FRAME_LIMIT,
      frameWindowMs: limits.frameWindowMs ?? FRAME_WINDOW_MS,
      keepBytes: limits.keepBytes ?? KEEP_BYTES,
      saveBytes: limits.saveBytes ?? SAVE_BYTES,
      saveEveryMs: limits.saveEveryMs ?? SAVE_EVERY_MS,
    }
    this.disk = options.disk
    this.warn = options.warn ?? (() => {})
    this.heartbeat = setInterval(() => {
      for (const room of this.rooms.values()) {
        for (const ws of room.conns.keys()) {
          if (!this.alive.has(ws)) {
            ws.terminate()
            continue
          }
          this.alive.delete(ws)
          ws.ping()
        }
      }
    }, PING_INTERVAL_MS)
    this.heartbeat.unref()

    if (this.disk) {
      try {
        for (const { room, bytes, rows, savedAt } of this.disk.savedDocs()) {
          this.saved.set(room, { bytes, rows, savedAt })
        }
      } catch (err) {
        this.failed('read what it has saved', err)
      }
      // Each module's index is read now rather than when somebody first asks,
      // because reading one deletes whatever saved document it marks deleted:
      // anything a failed delete left behind goes before anybody can open it.
      for (const name of [...this.saved.keys()]) {
        if (name.endsWith(INDEX_SUFFIX) && !this.rooms.has(name)) this.loadKept(name)
      }
      this.purgeBin()
      this.purgeTimer = setInterval(() => this.purgeBin(), PURGE_EVERY_MS)
      this.purgeTimer.unref()
    }
  }

  /**
   * A room's document, if this box has one: in memory, or saved.
   *
   * Not "if it has ever relayed one": a deleted document is gone, and so is
   * one the box let go of when it had saved too much (see `SAVE_BYTES`), or
   * that was never relayed on this database. So a caller gets the last copy
   * the box saw, or null until a device that has the document opens it —
   * which is the honest answer, and the reason every caller here has a
   * fallback.
   *
   * Read-only, and deliberately does *not* create an empty room — asking
   * whether anybody has put a running order on this box must not conjure an
   * empty one and start relaying it. A saved one is read back into memory.
   *
   * The relay has no business parsing what it carries (beyond the tombstones
   * in a module's index, see `isDeleted`); this exists so a
   * caller that legitimately reads one document (the control surface, for a
   * desk asking what is on next) can, without the relay growing an opinion
   * about the contents.
   */
  peek(name: string): Y.Doc | null {
    const room = this.rooms.get(name)
    if (room) return room.doc
    if (this.closed || !this.saved.has(name)) return null
    return this.loadKept(name)?.doc ?? null
  }

  /** Frame timestamps per connection, for `overFrameLimit`. */
  private frames = new WeakMap<WebSocket, number[]>()

  /** True (and records the frame) once a connection is over its rate. */
  private overFrameLimit(ws: WebSocket): boolean {
    const now = Date.now()
    const recent = (this.frames.get(ws) ?? []).filter((t) => now - t < this.limits.frameWindowMs)
    if (recent.length >= this.limits.frameLimit) {
      this.frames.set(ws, recent)
      return true
    }
    recent.push(now)
    this.frames.set(ws, recent)
    return false
  }

  /** Has this document reached the cap? Measured at most every few seconds. */
  private roomIsFull(room: Room): boolean {
    const now = Date.now()
    if (now - room.measuredAt >= MEASURE_EVERY_MS) {
      room.bytes = Y.encodeStateAsUpdate(room.doc).length
      room.measuredAt = now
    }
    return room.bytes > this.limits.maxRoomBytes
  }

  private getRoom(name: string): Room {
    let room = this.rooms.get(name)
    if (room) return room
    // Asked before the room exists, because the answer can mean reading the
    // module's index from disk, and reading an index deletes what it marks
    // deleted.
    const deleted = !name.endsWith(INDEX_SUFFIX) && this.isDeleted(name)
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalState(null)
    room = {
      doc,
      awareness,
      conns: new Map(),
      bytes: 0,
      measuredAt: 0,
      keptSince: null,
      pending: [],
      whole: false,
      deleted,
    }
    this.rooms.set(name, room)

    // A module's index says which of its documents have been deleted. A kept
    // one goes the moment its tombstone arrives, so keeping cannot hand
    // deleted paperwork back to a device that follows an old link to it.
    if (name.endsWith(INDEX_SUFFIX)) {
      const namespace = name.slice(0, -INDEX_SUFFIX.length)
      // Registered first, so a row is noted before the tombstone that
      // deletes it is acted on, whichever order a merge fires them in.
      const rows = doc.getMap<Y.Map<unknown>>(ENTRIES)
      const noteRows = () => this.noteEntries(namespace, rows)
      rows.observeDeep(noteRows)
      doc.getMap(TOMBSTONES).observe(() => this.forgetDeleted(namespace))
    }

    // Broadcast doc updates and awareness changes to every conn in the room,
    // and save what devices change.
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      this.broadcast(name, encoding.toUint8Array(encoder))
      if (origin !== FROM_DISK) this.queueSave(name, room!, update)
    })
    awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown
      ) => {
        // Track which awareness clients each conn speaks for (origin is the
        // conn that applied the update), so a drop removes exactly its
        // presence and nobody ghosts.
        const controlled = room!.conns.get(origin as WebSocket)
        if (controlled) {
          for (const id of added) controlled.add(id)
          for (const id of removed) controlled.delete(id)
        }
        const changed = [...added, ...updated, ...removed]
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, changed)
        )
        this.broadcast(name, encoding.toUint8Array(encoder))
      }
    )

    // What the box saved of it, before any device is told what it has. A
    // deleted one is not read, so an old link to it opens nothing.
    if (deleted) this.discard([name])
    else this.readSaved(name, room)
    return room
  }

  /** Apply what the box saved of a document to its room. */
  private readSaved(name: string, room: Room): void {
    if (!this.disk || !this.saved.has(name)) return
    let rows: Uint8Array[]
    try {
      rows = this.disk.loadDoc(name).rows
    } catch (err) {
      this.failed('read a saved document', err)
      return
    }
    try {
      if (rows.length > 0) Y.applyUpdate(room.doc, Y.mergeUpdates(rows), FROM_DISK)
    } catch (err) {
      // Rows that will not decode would fail every time anybody opened it.
      // The devices that have it still do, and give it back.
      this.failed('read a saved document', err)
      this.wipe([name])
    }
  }

  /**
   * Read a saved document into memory for nobody in particular: for `peek`,
   * and for a module's index when the relay needs to know what it says.
   */
  private loadKept(name: string): Room | null {
    const room = this.getRoom(name)
    room.bytes = Y.encodeStateAsUpdate(room.doc).length
    room.measuredAt = Date.now()
    if (room.deleted || room.bytes <= EMPTY_UPDATE_BYTES) {
      this.free(name, room)
      return null
    }
    room.keptSince = room.measuredAt
    this.trimKept(name)
    return room
  }

  /** A device changed a document: save it along with whatever else changes soon. */
  private queueSave(name: string, room: Room, update: Uint8Array): void {
    if (!this.disk || this.closed || room.deleted) return
    room.pending.push(update)
    this.dirty.add(name)
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (this.saveTimer || this.closed || !this.disk) return
    this.saveTimer = setTimeout(() => this.save(), this.limits.saveEveryMs)
    this.saveTimer.unref()
  }

  /**
   * Save everything waiting: each document's changes as one row, all in one
   * transaction. A document with enough rows, or marked to be saved whole,
   * is folded into one.
   */
  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (!this.disk) return
    const updates: { room: string; data: Uint8Array }[] = []
    const whole: string[] = []
    for (const name of this.dirty) {
      const room = this.rooms.get(name)
      if (!room || room.deleted) continue
      if (room.whole) whole.push(name)
      else if (room.pending.length > 0) {
        updates.push({ room: name, data: Y.mergeUpdates(room.pending) })
      }
    }
    this.dirty.clear()
    const now = Date.now()
    if (updates.length > 0) {
      try {
        this.disk.appendDocs(updates, now)
        this.failing = false
        for (const { room: name, data } of updates) {
          this.rooms.get(name)!.pending = []
          const was = this.saved.get(name)
          const rows = (was?.rows ?? 0) + 1
          this.saved.set(name, { bytes: (was?.bytes ?? 0) + data.length, rows, savedAt: now })
          if (rows > COMPACT_ROWS) whole.push(name)
        }
      } catch (err) {
        // What was waiting is in the documents, and each is saved whole the
        // next time the relay saves: after the next change anywhere, when
        // its last device leaves, or when the box shuts down.
        for (const { room: name } of updates) {
          const room = this.rooms.get(name)!
          room.pending = []
          room.whole = true
          this.dirty.add(name)
        }
        this.failed('save shared documents', err)
      }
    }
    for (const name of whole) {
      // Looked up again: folding one document can apply rows that delete another.
      const room = this.rooms.get(name)
      if (room) this.compact(name, room)
    }
    this.trimSaved()
    if (this.emptyLog) {
      try {
        this.disk.emptyDocLog()
        this.emptyLog = false
      } catch (err) {
        this.failed('empty the database log', err)
      }
    }
  }

  /**
   * Replace a document's saved rows with its state, which has everything in
   * them: what devices changed since, and nothing of what was deleted.
   */
  private compact(name: string, room: Room): void {
    if (!this.disk || room.deleted) return
    const now = Date.now()
    try {
      const { rows, upTo } = this.disk.loadDoc(name)
      // What is saved is taken in first, so folding never loses a row: one
      // that could not be read back when the document was opened, say.
      // Rows the document already has change nothing.
      if (rows.length > 0) Y.applyUpdate(room.doc, Y.mergeUpdates(rows), FROM_DISK)
      const state = Y.encodeStateAsUpdate(room.doc)
      this.disk.compactDoc(name, state, upTo, now)
      this.saved.set(name, { bytes: state.length, rows: 1, savedAt: now })
      room.pending = []
      room.whole = false
      this.failing = false
    } catch (err) {
      room.whole = true
      this.dirty.add(name)
      this.failed('save shared documents', err)
    }
  }

  /** A module's index changed: note its rows, keeping any since removed. */
  private noteEntries(namespace: string, rows: Y.Map<Y.Map<unknown>>): void {
    let known = this.entries.get(namespace)
    if (!known) this.entries.set(namespace, (known = new Map()))
    for (const [id, row] of rows.entries()) {
      if (!(row instanceof Y.Map)) continue
      const fields: Record<string, string> = {}
      for (const [key, value] of row.entries()) if (typeof value === 'string') fields[key] = value
      known.set(id, fields)
    }
  }

  /** The id an index tombstone uses for a room, `<module>/<kind>-<id>`, if any. */
  private idOf(name: string): string | null {
    const indexName = name.slice(0, name.indexOf('/')) + INDEX_SUFFIX
    const index = this.rooms.get(indexName)
    if (index) {
      for (const id of index.doc.getMap(TOMBSTONES).keys()) if (name.endsWith(`-${id}`)) return id
    }
    for (const id of this.entries.get(name.slice(0, name.indexOf('/')))?.keys() ?? []) {
      if (name.endsWith(`-${id}`)) return id
    }
    return null
  }

  /**
   * Deleted documents: into the bin with their index rows, then off the
   * box's disk. `open` holds the ones in memory, whose state is the fullest
   * copy; the rest are read from disk. An empty one is only wiped.
   */
  private discard(names: string[], open: Map<string, Room> = new Map()): void {
    if (!this.disk) return
    const binned: { room: string; entry: string; data: Uint8Array }[] = []
    for (const name of names) {
      let state: Uint8Array | null = null
      try {
        const room = open.get(name)
        if (room) state = Y.encodeStateAsUpdate(room.doc)
        else if (this.saved.has(name)) {
          const { rows } = this.disk.loadDoc(name)
          if (rows.length > 0) state = Y.mergeUpdates(rows)
        }
      } catch (err) {
        this.failed('put a deleted document in the bin', err)
      }
      if (!state || state.length <= EMPTY_UPDATE_BYTES) continue
      const id = this.idOf(name)
      const row = id ? this.entries.get(name.slice(0, name.indexOf('/')))?.get(id) : undefined
      binned.push({ room: name, entry: JSON.stringify(row ?? {}), data: state })
    }
    try {
      this.disk.binDocs(binned, Date.now())
    } catch (err) {
      // Not wiped either: a delete that cannot be kept is retried the next
      // time the index is read, rather than lost.
      this.failed('put a deleted document in the bin', err)
      return
    }
    this.wipe(names)
  }

  /** Wipe what has been in the bin longer than `BIN_MS`. */
  purgeBin(now = Date.now()): number {
    if (!this.disk || this.closed) return 0
    try {
      const old = this.disk
        .listBin()
        .filter((doc) => now - doc.deletedAt >= BIN_MS)
        .map((doc) => doc.room)
      if (old.length === 0) return 0
      this.disk.unbinDocs(old)
      this.emptyLog = true
      this.scheduleSave()
      return old.length
    } catch (err) {
      this.failed('empty the bin', err)
      return 0
    }
  }

  /** What is in the bin, newest deletion first. */
  bin(): BinnedDoc[] {
    if (!this.disk) return []
    return this.disk
      .listBin()
      .map(({ room, entry, bytes, deletedAt }) => {
        let title = ''
        try {
          const row = JSON.parse(entry) as Record<string, unknown>
          if (typeof row.title === 'string') title = row.title
        } catch {
          // A row that will not parse lists with no title.
        }
        return {
          room,
          module: room.slice(0, room.indexOf('/')),
          title,
          deletedAt,
          purgesAt: deletedAt + BIN_MS,
          bytes,
        }
      })
      .sort((a, b) => b.deletedAt - a.deletedAt || a.room.localeCompare(b.room))
  }

  /** Wipe one document from the bin now, rather than when its week is up. */
  emptyFromBin(name: string): boolean {
    if (!this.disk || !this.disk.loadBin(name)) return false
    this.disk.unbinDocs([name])
    this.emptyLog = true
    this.scheduleSave()
    return true
  }

  /**
   * Bring a document back from the bin: saved again, listed again in its
   * module's index, and its tombstone taken away, so every device lists it
   * and opens it from the box. Devices that deleted their own copy fetch it;
   * a device that was offline for the delete never lost it.
   */
  restore(name: string): boolean {
    if (!this.disk || this.closed) return false
    const binned = this.disk.loadBin(name)
    if (!binned) return false
    const namespace = name.slice(0, name.indexOf('/'))
    const indexName = namespace + INDEX_SUFFIX
    const index = this.rooms.get(indexName) ?? this.getRoom(indexName)
    if (index.conns.size === 0 && index.keptSince === null) index.keptSince = Date.now()
    const tombstones = index.doc.getMap<string>(TOMBSTONES)
    const id = [...tombstones.keys()].find((key) => name.endsWith(`-${key}`))
    let row: Record<string, string> = {}
    try {
      row = JSON.parse(binned.entry) as Record<string, string>
    } catch {
      // Listed with its module's default title.
    }

    // The document first, so that a device told it exists finds it here.
    const now = Date.now()
    this.disk.appendDocs([{ room: name, data: binned.data }], now)
    const was = this.saved.get(name)
    this.saved.set(name, {
      bytes: (was?.bytes ?? 0) + binned.data.length,
      rows: (was?.rows ?? 0) + 1,
      savedAt: now,
    })
    const room = this.rooms.get(name)
    if (room) {
      room.deleted = false
      if (room.conns.size === 0) this.free(name, room)
      else {
        Y.applyUpdate(room.doc, binned.data, FROM_DISK)
        room.whole = true
        this.dirty.add(name)
      }
    }

    index.doc.transact(() => {
      if (id) tombstones.delete(id)
      const rows = index.doc.getMap<Y.Map<unknown>>(ENTRIES)
      const key = id ?? this.idOf(name)
      if (key && !rows.has(key)) {
        const entry = new Y.Map<unknown>()
        rows.set(key, entry)
        for (const [field, value] of Object.entries(row)) {
          if (typeof value === 'string') entry.set(field, value)
        }
      }
    }, RESTORED)
    this.disk.unbinDocs([name])
    this.scheduleSave()
    return true
  }

  /** Delete documents from the box's disk. */
  private wipe(names: string[]): void {
    const saved = names.filter((name) => this.saved.has(name))
    if (!this.disk || saved.length === 0) return
    try {
      this.disk.wipeDocs(saved)
      for (const name of saved) this.saved.delete(name)
      this.failing = false
      // Soon rather than now: a delete often comes in a burst, and inside a
      // change to an index, which is no place to be writing.
      this.emptyLog = true
      this.scheduleSave()
    } catch (err) {
      // Still listed as saved, so the next time its index is read tries again.
      this.failed('delete shared documents', err)
    }
  }

  /**
   * Delete the least recently saved documents from disk until what is saved
   * fits the budget. Never one somebody has open, and a module's index last,
   * as in `trimKept`.
   */
  private trimSaved(): void {
    let total = 0
    for (const { bytes } of this.saved.values()) total += bytes
    if (total <= this.limits.saveBytes) return
    const index = (name: string) => (name.endsWith(INDEX_SUFFIX) ? 1 : 0)
    const order = [...this.saved]
      .filter(([name]) => this.rooms.get(name)?.keptSince !== null)
      .sort(([a, x], [b, y]) => index(a) - index(b) || x.savedAt - y.savedAt)
    const gone: string[] = []
    for (const [name, { bytes }] of order) {
      if (total <= this.limits.saveBytes) break
      total -= bytes
      gone.push(name)
      const room = this.rooms.get(name)
      if (room) this.free(name, room)
    }
    this.wipe(gone)
  }

  /** Say once that saving is failing, rather than on every save while it does. */
  private failed(what: string, err: unknown): void {
    if (this.failing) return
    this.failing = true
    const reason = err instanceof Error ? err.message : String(err)
    this.warn(`docs relay: could not ${what} (${reason}). The devices that have them still do.`)
  }

  private broadcast(roomName: string, payload: Uint8Array): void {
    const room = this.rooms.get(roomName)
    if (!room) return
    for (const ws of room.conns.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(payload)
    }
  }

  /** Attach an upgraded, authenticated connection to a room. */
  connect(ws: WebSocket, roomName: string): void {
    const room = this.getRoom(roomName)
    room.conns.set(ws, new Set())
    room.keptSince = null
    this.alive.add(ws)
    ws.binaryType = 'arraybuffer'

    // First, before anything can emit. `ws` raises `error` for a framing
    // violation — a reserved bit set, invalid UTF-8, a frame over maxPayload
    // — and an `error` event with no listener is rethrown by EventEmitter,
    // which here means the whole box exits. The chat hub has always had this;
    // the relay did not, so a phone with a large enough patch sheet could
    // take the box down by accident and one bad frame could do it on purpose.
    //
    // Nothing is logged: this is reachable per frame, and a line per frame is
    // a way to fill a disk. The close is the response.
    ws.on('error', () => ws.close())

    ws.on('pong', () => this.alive.add(ws))

    ws.on('message', (data: Buffer | ArrayBuffer) => {
      const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data)
      let decoder: decoding.Decoder
      let messageType: number
      try {
        decoder = decoding.createDecoder(bytes)
        messageType = decoding.readVarUint(decoder)
      } catch {
        return
      }
      // Both kinds of frame count. A flood of awareness updates is the
      // same amount of work for every other phone in the room as a flood of
      // document ones.
      if (this.overFrameLimit(ws)) {
        ws.close(1008, 'too many frames')
        return
      }
      try {
        switch (messageType) {
          case MESSAGE_SYNC: {
            // Refuse to grow a room that is already too big. Yjs cannot
            // un-apply an update, so the check has to come first — and it
            // is the room that is bounded rather than the frame, because a
            // document is grown by a thousand small writes as readily as by
            // one large one.
            if (this.roomIsFull(room)) {
              ws.close(1009, 'document is full')
              return
            }
            const encoder = encoding.createEncoder()
            encoding.writeVarUint(encoder, MESSAGE_SYNC)
            syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws)
            // Reply only when the read produced one (sync step 2).
            if (encoding.length(encoder) > 1 && ws.readyState === ws.OPEN) {
              ws.send(encoding.toUint8Array(encoder))
            }
            break
          }
          case MESSAGE_AWARENESS: {
            const update = decoding.readVarUint8Array(decoder)
            awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws)
            break
          }
        }
      } catch {
        // A malformed frame must not take the relay down; drop the conn.
        ws.close()
      }
    })

    ws.on('close', () => {
      const controlled = room.conns.get(ws)
      room.conns.delete(ws)
      if (controlled?.size) {
        awarenessProtocol.removeAwarenessStates(room.awareness, [...controlled], null)
      }
      if (room.conns.size === 0) this.release(roomName, room)
    })

    // Handshake: sync step 1, plus current awareness states if any.
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, room.doc)
    ws.send(encoding.toUint8Array(encoder))
    const states = room.awareness.getStates()
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder()
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()])
      )
      ws.send(encoding.toUint8Array(awarenessEncoder))
    }
  }

  /**
   * The last device has left a room: keep its document for whoever opens it
   * next, unless there is nothing in it (a link to a sheet this box has never
   * seen opens an empty one) or its module's index says it has been deleted.
   */
  private release(name: string, room: Room): void {
    if (this.closed) {
      this.free(name, room)
      return
    }
    room.bytes = Y.encodeStateAsUpdate(room.doc).length
    room.measuredAt = Date.now()
    if (room.bytes <= EMPTY_UPDATE_BYTES) {
      this.free(name, room)
      this.wipe([name])
      return
    }
    if (room.deleted || this.isDeleted(name)) {
      this.discard([name], new Map([[name, room]]))
      this.free(name, room)
      return
    }
    // Nobody is changing it now, so what it has on disk and what was waiting
    // to be saved become one row.
    const rows = this.saved.get(name)?.rows ?? 0
    if (room.pending.length > 0 || room.whole || rows > 1) this.compact(name, room)
    room.keptSince = room.measuredAt
    this.trimKept()
    this.trimSaved()
  }

  private free(name: string, room: Room): void {
    room.awareness.destroy()
    room.doc.destroy()
    this.rooms.delete(name)
  }

  /**
   * Let the longest-kept documents go from memory until what is kept fits the
   * budget. They are still saved. `except` is one just read back, which its
   * caller is about to use.
   *
   * A module's index goes last, however long it has been kept: it is a few
   * kilobytes, and it is what says which kept documents have been deleted.
   */
  private trimKept(except?: string): void {
    const kept = [...this.rooms].filter(([, room]) => room.keptSince !== null)
    let total = kept.reduce((sum, [, room]) => sum + room.bytes, 0)
    const index = (name: string) => (name.endsWith(INDEX_SUFFIX) ? 1 : 0)
    kept.sort(([a, x], [b, y]) => index(a) - index(b) || x.keptSince! - y.keptSince!)
    for (const [name, room] of kept) {
      if (total <= this.limits.keepBytes) break
      if (name === except) continue
      total -= room.bytes
      this.free(name, room)
    }
  }

  /**
   * Has this document's module index marked it deleted?
   *
   * The one thing the relay reads in what it carries, for the reason given
   * where index rooms are made. A document's room is `<module>/<kind>-<id>`,
   * and its module's index is `<module>/index`, with the ids of deleted
   * documents in a map of their own (web/src/lib/docs/indexDoc.ts). The id is
   * matched against the end of the name rather than cut out of it, so a dash
   * in a kind or an id cannot defeat the check.
   */
  private isDeleted(name: string): boolean {
    const indexName = name.slice(0, name.indexOf('/')) + INDEX_SUFFIX
    const index =
      this.rooms.get(indexName) ??
      (this.saved.has(indexName) && !this.closed ? this.loadKept(indexName) : null)
    if (!index) return false
    for (const id of index.doc.getMap(TOMBSTONES).keys()) {
      if (name.endsWith(`-${id}`)) return true
    }
    return false
  }

  /**
   * A module's index has changed: delete what it now marks deleted from the
   * box's disk. A kept document goes from memory too, and one somebody has
   * open goes when they leave. None of them is saved again.
   */
  private forgetDeleted(namespace: string): void {
    const inModule = (name: string) =>
      name.startsWith(`${namespace}/`) && !name.endsWith(INDEX_SUFFIX)
    const gone: string[] = []
    const open = new Map<string, Room>()
    for (const [name, room] of this.rooms) {
      if (room.deleted || !inModule(name) || !this.isDeleted(name)) continue
      room.deleted = true
      room.pending = []
      gone.push(name)
      open.set(name, room)
    }
    for (const name of this.saved.keys()) {
      if (inModule(name) && !this.rooms.has(name) && this.isDeleted(name)) gone.push(name)
    }
    // Into the bin while the documents in memory still hold what they had,
    // including changes that had not been saved yet.
    const wiped = gone.filter((name) => this.saved.has(name) || open.has(name))
    if (wiped.length > 0) this.discard(wiped, open)
    for (const [name, room] of open) if (room.keptSince !== null) this.free(name, room)
    if (wiped.length === 0) return
    // The index's own rows still say what each one was called, until they
    // are folded into its state, which does not. Not from in here: this runs
    // inside a change to the index.
    const indexName = namespace + INDEX_SUFFIX
    const index = this.rooms.get(indexName)
    if (index) {
      index.whole = true
      this.dirty.add(indexName)
      this.scheduleSave()
    }
  }

  /**
   * Rooms somebody has open and their connections, what is kept in memory
   * for nobody in particular, and what is saved, in encoded bytes.
   */
  stats(): {
    rooms: number
    connections: number
    kept: number
    keptBytes: number
    saved: number
    savedBytes: number
  } {
    let rooms = 0
    let connections = 0
    let kept = 0
    let keptBytes = 0
    let savedBytes = 0
    for (const { bytes } of this.saved.values()) savedBytes += bytes
    for (const room of this.rooms.values()) {
      if (room.keptSince === null) {
        rooms++
        connections += room.conns.size
      } else {
        kept++
        keptBytes += room.bytes
      }
    }
    return { rooms, connections, kept, keptBytes, saved: this.saved.size, savedBytes }
  }

  /**
   * Shut down. What changed since the last save is saved now. What is kept
   * goes from memory now, and what is open goes as its devices' connections
   * close, so no room is left holding its presence timer.
   */
  close(): void {
    clearInterval(this.heartbeat)
    if (this.purgeTimer) clearInterval(this.purgeTimer)
    this.save()
    this.closed = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    for (const [name, room] of this.rooms) {
      if (room.conns.size === 0) this.free(name, room)
      for (const ws of room.conns.keys()) ws.close()
    }
  }
}

/**
 * Namespaces the shell owns rather than any module.
 *
 * The timetable — who is on, where, and when — is consulted by every
 * department and belongs to the event, not to whoever happens to have it
 * open. A box that turns off a module must not lose it, so it is always
 * reachable and is not in CREWBOX_MODULES.
 */
export const SHELL_NAMESPACES: readonly string[] = ['timetable']

/**
 * Room names are namespaced by module id — `patch/sheet-<id>` — so the relay
 * never hosts an unscoped, colliding room space, and a module can only be
 * reached when the box enables it. The shell's own namespaces are always
 * allowed; see SHELL_NAMESPACES.
 */
export function parseRoomName(room: string, enabledModules: string[]): string | null {
  const match = /^([a-z0-9-]+)\/([A-Za-z0-9._:-]{1,128})$/.exec(room)
  if (!match) return null
  const namespace = match[1]!
  if (!SHELL_NAMESPACES.includes(namespace) && !enabledModules.includes(namespace)) return null
  return room
}
