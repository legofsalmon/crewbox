import type * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { loadSyncSettings, saveSyncSettings, type SyncSettings } from './syncSettings'

export type SyncStatus = 'off' | 'connecting' | 'connected'

export interface RemotePeer {
  clientId: number
  name: string
  color: string
  /** `${artistId}:${channelId}:${field}` of the cell the peer is editing, if any. */
  editingCell: string | null
}

/** Stable per-session device id, announced via awareness so peers can be counted. */
const deviceId = crypto.randomUUID()

const USER_NAME_KEY = 'livepatch-user-name'

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

const loadUserName = (): string => {
  try {
    return localStorage.getItem(USER_NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Attaches a y-websocket provider to every open doc (the doc/room name is the
 * same string as the IndexedDB database name). When there is no configured
 * relay URL the app simply runs local-only — that is a fully supported mode,
 * not an error.
 */
class SyncManager {
  private docs = new Map<string, Y.Doc>()
  private providers = new Map<string, WebsocketProvider>()
  private connected = new Map<string, boolean>()
  private settings: SyncSettings = loadSyncSettings()
  private listeners = new Set<() => void>()
  private userName = loadUserName()
  private peerCache = new Map<string, { key: string; value: RemotePeer[] }>()

  getSettings(): SyncSettings {
    return this.settings
  }

  updateSettings(settings: SyncSettings) {
    // Only the transport (url/token) requires reconnecting providers. A
    // name-only save must NOT churn connections — that reconnect drops and
    // re-establishes presence, so peers briefly vanish. Display-name changes
    // propagate live via setUserName's awareness update instead.
    const transportChanged =
      settings.url !== this.settings.url || settings.token !== this.settings.token
    this.settings = settings
    saveSyncSettings(settings)
    if (transportChanged) {
      for (const name of [...this.providers.keys()]) this.disconnectDoc(name)
      for (const [name, doc] of this.docs) this.connectDoc(name, doc)
    }
    this.emit()
  }

  getUserName(): string {
    return this.userName
  }

  setUserName(name: string) {
    this.userName = name.trim()
    try {
      localStorage.setItem(USER_NAME_KEY, this.userName)
    } catch {
      // Not persisted, but still applied for this session.
    }
    for (const provider of this.providers.values()) {
      provider.awareness.setLocalStateField('user', this.userField())
    }
    this.emit()
  }

  /** Announce which cell this device is editing in the given doc's room. */
  setEditingCell(name: string, cell: string | null) {
    this.providers.get(name)?.awareness.setLocalStateField('editing', cell)
  }

  attach(name: string, doc: Y.Doc) {
    if (this.docs.has(name)) return
    this.docs.set(name, doc)
    this.connectDoc(name, doc)
  }

  detach(name: string) {
    this.disconnectDoc(name)
    this.docs.delete(name)
    this.emit()
  }

  private userField() {
    return { id: deviceId, name: this.userName, color: colorFor(deviceId) }
  }

  private connectDoc(name: string, doc: Y.Doc) {
    if (!this.settings.url || typeof WebSocket === 'undefined') return
    const provider = new WebsocketProvider(this.settings.url, name, doc, {
      params: this.settings.token ? { token: this.settings.token } : {},
    })
    provider.on('status', ({ status }: { status: string }) => {
      this.connected.set(name, status === 'connected')
      this.emit()
    })
    // Peers only appear in each other's awareness once a local state is set —
    // an untouched (empty) state is never broadcast on join.
    provider.awareness.setLocalStateField('user', this.userField())
    provider.awareness.on('change', () => this.emit())
    this.providers.set(name, provider)
  }

  private disconnectDoc(name: string) {
    const provider = this.providers.get(name)
    if (provider) {
      provider.destroy()
      this.providers.delete(name)
    }
    this.connected.delete(name)
    this.peerCache.delete(name)
  }

  /** Overall status: connected if any room is, connecting if trying, off if unconfigured. */
  status(): SyncStatus {
    if (!this.settings.url) return 'off'
    for (const isUp of this.connected.values()) if (isUp) return 'connected'
    return 'connecting'
  }

  /** Number of devices (including this one) in a doc's room, from awareness. */
  peers(name: string): number {
    const provider = this.providers.get(name)
    if (!provider || !this.connected.get(name)) return 0
    return provider.awareness.getStates().size
  }

  /**
   * Remote peers in a doc's room (excluding this device). Returns a cached
   * array reference while the underlying states are unchanged so it can be a
   * useSyncExternalStore snapshot.
   */
  remotePeers(name: string): RemotePeer[] {
    const provider = this.providers.get(name)
    if (!provider || !this.connected.get(name)) return EMPTY_PEERS
    const peers: RemotePeer[] = []
    for (const [clientId, state] of provider.awareness.getStates()) {
      if (clientId === provider.awareness.clientID) continue
      const user = (state as { user?: { name?: string; color?: string } }).user
      if (!user) continue
      peers.push({
        clientId,
        name: user.name?.trim() || 'Crew member',
        color: user.color ?? PEER_COLORS[0],
        editingCell: (state as { editing?: string | null }).editing ?? null,
      })
    }
    peers.sort((a, b) => a.clientId - b.clientId)
    const key = JSON.stringify(peers)
    const cached = this.peerCache.get(name)
    if (cached && cached.key === key) return cached.value
    this.peerCache.set(name, { key, value: peers })
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
