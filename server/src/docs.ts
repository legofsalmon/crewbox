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
 * Docs live in memory only while clients are connected — the durable copies
 * are the clients' IndexedDB stores, which re-seed state on every connect
 * (Live Patch's model, unchanged). The box's only server-side module state
 * is file attachments, which go through the existing files service.
 */

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

const PING_INTERVAL_MS = 15_000

interface Room {
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  /** conn → awareness clientIds it controls (cleared when it drops). */
  conns: Map<WebSocket, Set<number>>
  /** Encoded size of the document, last time it was measured. */
  bytes: number
  /** When that was, so the measurement is not taken per frame. */
  measuredAt: number
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
}

export class DocsRelay {
  private rooms = new Map<string, Room>()
  private heartbeat: NodeJS.Timeout
  private alive = new WeakSet<WebSocket>()
  private limits: RelayLimits

  constructor(limits: Partial<RelayLimits> = {}) {
    this.limits = {
      maxRoomBytes: limits.maxRoomBytes ?? MAX_ROOM_BYTES,
      frameLimit: limits.frameLimit ?? FRAME_LIMIT,
      frameWindowMs: limits.frameWindowMs ?? FRAME_WINDOW_MS,
    }
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
  }

  /**
   * A room's document, if this box has ever relayed one.
   *
   * Read-only, and deliberately does *not* create the room — asking whether
   * anybody has put a running order on this box must not conjure an empty
   * one and start relaying it.
   *
   * The relay has no business parsing what it carries; this exists so a
   * caller that legitimately reads one document (the control surface, for a
   * desk asking what is on next) can, without the relay growing an opinion
   * about the contents.
   */
  peek(name: string): Y.Doc | null {
    return this.rooms.get(name)?.doc ?? null
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
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalState(null)
    room = { doc, awareness, conns: new Map(), bytes: 0, measuredAt: 0 }
    this.rooms.set(name, room)

    // Broadcast doc updates and awareness changes to every conn in the room.
    doc.on('update', (update: Uint8Array) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      this.broadcast(name, encoding.toUint8Array(encoder))
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
    return room
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
      // Last one out: free the doc — clients hold the durable copies.
      if (room.conns.size === 0) {
        room.awareness.destroy()
        room.doc.destroy()
        this.rooms.delete(roomName)
      }
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

  stats(): { rooms: number; connections: number } {
    let connections = 0
    for (const room of this.rooms.values()) connections += room.conns.size
    return { rooms: this.rooms.size, connections }
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const room of this.rooms.values()) {
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
