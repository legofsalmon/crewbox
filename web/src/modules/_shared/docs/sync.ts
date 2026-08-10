import type * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { docsWsUrl } from '../../../lib/server.ts'
import { sessionToken, useStore } from '../../../store.ts'

export type SyncStatus = 'off' | 'connecting' | 'connected'

export interface RemotePeer {
  clientId: number
  name: string
  color: string
  /**
   * Opaque key of whatever this peer is editing, as defined by the owning
   * module — patch uses `${artistId}:${channelId}:${field}`. Null when the
   * peer is present but not in a field.
   */
  editing: string | null
}

const PEER_COLORS = [
  '#e74c3c',
  '#3498db',
  '#27ae60',
  '#f39c12',
  '#9b59b6',
  '#16a085',
  '#d35400',
  '#2c3e50',
]

const colorFor = (id: string): string => {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length]
}

/**
 * Attaches a y-websocket provider to every open module doc, syncing through
 * the crewbox server's shared-docs relay (/ws/docs). Rooms are addressed by
 * their full `<moduleId>/<docName>` name — the same string the server's
 * namespace check parses — so one manager serves every module without
 * knowing what any of them are.
 *
 * Where Live Patch had a configurable relay URL, a shared token, and a
 * self-assigned display name, crewbox has exactly one server and one
 * identity: the session token authenticates the socket, and presence is the
 * crew member from the roster — "Sarah is editing this cell" means the
 * actual Sarah from chat.
 *
 * Without a session (not joined yet) docs simply stay local — the same
 * fully-supported local-only mode Live Patch had without a relay.
 */
class SyncManager {
  private docs = new Map<string, Y.Doc>()
  private providers = new Map<string, WebsocketProvider>()
  /** Rooms this device is a *person* in, as opposed to merely syncing. */
  private present = new Set<string>()
  private connected = new Map<string, boolean>()
  private listeners = new Set<() => void>()
  private peerCache = new Map<string, { key: string; value: RemotePeer[] }>()

  /** Announce what this device is editing in the given room. */
  setEditing(room: string, key: string | null) {
    this.providers.get(room)?.awareness.setLocalStateField('editing', key)
  }

  /**
   * Sync a document, optionally without announcing anybody.
   *
   * `present` is the difference between "this device is keeping this document
   * up to date" and "somebody is looking at this document", and they are not
   * the same thing. The running order reads every patch sheet on the box to
   * work out what is on; without this it appeared in every sheet's presence
   * as a third device, so a patch operator saw phantom company in a sheet
   * nobody else had open.
   *
   * A room already attached silently can be promoted later — which is what
   * happens the moment someone actually opens that sheet.
   */
  attach(room: string, doc: Y.Doc, { present = true }: { present?: boolean } = {}) {
    if (this.docs.has(room)) {
      if (present) this.announce(room)
      return
    }
    this.docs.set(room, doc)
    if (present) this.present.add(room)
    this.connectDoc(room, doc)
  }

  /** Start appearing in a room this device was already syncing quietly. */
  private announce(room: string) {
    if (this.present.has(room)) return
    this.present.add(room)
    this.providers.get(room)?.awareness.setLocalStateField('user', this.userField())
    this.emit()
  }

  detach(room: string) {
    this.disconnectDoc(room)
    this.docs.delete(room)
    this.present.delete(room)
    this.emit()
  }

  /** Connect docs opened before login; refresh presence after profile changes. */
  refresh() {
    for (const [room, doc] of this.docs) {
      if (!this.providers.has(room)) this.connectDoc(room, doc)
    }
    // Only rooms this device is actually present in. Refreshing every
    // provider would announce the background readers too, undoing the whole
    // point of attaching quietly.
    for (const [room, provider] of this.providers) {
      if (this.present.has(room)) provider.awareness.setLocalStateField('user', this.userField())
    }
  }

  private userField() {
    const me = useStore.getState().me
    return {
      id: me?.id ?? 'anonymous',
      name: me?.name ?? 'Crew member',
      color: colorFor(me?.id ?? 'anonymous'),
    }
  }

  private connectDoc(room: string, doc: Y.Doc) {
    const token = sessionToken()
    if (!token || typeof WebSocket === 'undefined') return
    const provider = new WebsocketProvider(docsWsUrl(), room, doc, { params: { token } })
    provider.on('status', ({ status }: { status: string }) => {
      this.connected.set(room, status === 'connected')
      this.emit()
    })
    // Peers only appear in each other's awareness once a local state is set —
    // an untouched (empty) state is never broadcast on join. That is exactly
    // what keeps a background reader (see attach) invisible: it syncs the
    // document and announces nobody.
    if (this.present.has(room)) provider.awareness.setLocalStateField('user', this.userField())
    provider.awareness.on('change', () => this.emit())
    this.providers.set(room, provider)
  }

  private disconnectDoc(room: string) {
    const provider = this.providers.get(room)
    if (provider) {
      provider.destroy()
      this.providers.delete(room)
    }
    this.connected.delete(room)
    this.peerCache.delete(room)
  }

  /** Overall status: connected if any room is, connecting if trying, off without a session. */
  status(): SyncStatus {
    if (this.providers.size === 0) return 'off'
    for (const isUp of this.connected.values()) if (isUp) return 'connected'
    return 'connecting'
  }

  /** Number of devices (including this one) in a room, from awareness. */
  peers(room: string): number {
    const provider = this.providers.get(room)
    if (!provider || !this.connected.get(room)) return 0
    return provider.awareness.getStates().size
  }

  /**
   * Remote peers in a room (excluding this device). Returns a cached array
   * reference while the underlying states are unchanged so it can be a
   * useSyncExternalStore snapshot.
   */
  remotePeers(room: string): RemotePeer[] {
    const provider = this.providers.get(room)
    if (!provider || !this.connected.get(room)) return EMPTY_PEERS
    const peers: RemotePeer[] = []
    for (const [clientId, state] of provider.awareness.getStates()) {
      if (clientId === provider.awareness.clientID) continue
      const user = (state as { user?: { name?: string; color?: string } }).user
      if (!user) continue
      peers.push({
        clientId,
        name: user.name?.trim() || 'Crew member',
        color: user.color ?? PEER_COLORS[0]!,
        editing: (state as { editing?: string | null }).editing ?? null,
      })
    }
    peers.sort((a, b) => a.clientId - b.clientId)
    const key = JSON.stringify(peers)
    const cached = this.peerCache.get(room)
    if (cached && cached.key === key) return cached.value
    this.peerCache.set(room, { key, value: peers })
    return peers
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }
}

const EMPTY_PEERS: RemotePeer[] = []

export const syncManager = new SyncManager()

// Docs opened pre-login connect once a session exists, and presence follows
// name changes — both flow from shell identity state, not module settings.
let lastIdentity = ''
useStore.subscribe((state) => {
  const identity = `${sessionToken() ?? ''}:${state.me?.id ?? ''}:${state.me?.name ?? ''}`
  if (identity !== lastIdentity) {
    lastIdentity = identity
    syncManager.refresh()
  }
})
