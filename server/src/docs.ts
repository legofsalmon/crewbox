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
}

export class DocsRelay {
  private rooms = new Map<string, Room>()
  private heartbeat: NodeJS.Timeout
  private alive = new WeakSet<WebSocket>()

  constructor() {
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

  private getRoom(name: string): Room {
    let room = this.rooms.get(name)
    if (room) return room
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalState(null)
    room = { doc, awareness, conns: new Map() }
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
      try {
        switch (messageType) {
          case MESSAGE_SYNC: {
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
