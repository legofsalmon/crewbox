import { create } from 'zustand'
import {
  HOME_CHANNEL,
  newId,
  PROTOCOL_VERSION,
  type Channel,
  type DmxUniverseWire,
  type Message,
  type Incident,
  type PublicConfig,
  type ServerMessage,
  type User,
  type WelcomeMessage,
} from '@crewbox/shared'
import { cache, type OutboxEntry } from './lib/db.ts'
import {
  queueIncident,
  queuedIncidents,
  unqueueIncident,
  type QueuedIncident,
} from './modules/incident/model/outbox.ts'
import { WsClient } from './lib/ws.ts'
import * as api from './lib/api.ts'
import {
  isMentioned,
  notify,
  playAlert,
  requestNotificationPermission,
  setSoundsEnabled,
  soundsEnabled,
} from './lib/alerts.ts'
import { initialVoiceState, type VoiceState } from './lib/voice-state.ts'
import type { VoiceManager } from './lib/voice.ts'
import { APP_VERSION, checkForUpdate, initPwa } from './lib/pwa.ts'
import { isNative, nativeAlerts, serverOrigin } from './lib/server.ts'
import { measureImage } from './lib/files.ts'
import { currentRoute, navigate, onRouteChange, type Route } from './shell/router.ts'

const TOKEN_KEY = 'crewbox:token'
const THEME_KEY = 'crewbox:theme'
const SSID_KEY = 'crewbox:wifi-ssid'
const EVENT_NAME_KEY = 'crewbox:event-name'
const MODULES_KEY = 'crewbox:modules'
const TYPING_TTL_MS = 4000
const TYPING_THROTTLE_MS = 2500

/**
 * Last-known Wi-Fi SSID, event name and enabled modules, cached so a cold
 * offline start shows the event it belongs to, the network to rejoin, and the
 * department panes this box actually runs — rather than generic copy.
 *
 * Modules matter most: without caching them, a phone that reopens the app with
 * no signal falls back to chat-only, hiding the patch sheet and lighting the
 * crew were using minutes ago. Offline is the default here, so the last-known
 * shape has to survive a cold start.
 */
function initialConfig(): PublicConfig {
  const cachedModules = localStorage.getItem(MODULES_KEY)
  return {
    eventName: localStorage.getItem(EVENT_NAME_KEY) ?? '',
    wifiSsid: localStorage.getItem(SSID_KEY) ?? '',
    voiceEnabled: true,
    // Chat is always on; the cache carries whatever else this box last ran.
    modules: cachedModules ? cachedModules.split(',').filter(Boolean) : ['chat'],
  }
}

function remember(key: string, value: string | undefined): void {
  if (value) localStorage.setItem(key, value)
  else localStorage.removeItem(key)
}

function rememberConfig(config: PublicConfig): void {
  remember(SSID_KEY, config.wifiSsid)
  remember(EVENT_NAME_KEY, config.eventName)
  // So the next cold offline start shows the same department panes.
  remember(MODULES_KEY, config.modules.join(','))
}

export interface Pending {
  clientMsgId: string
  channelId: string
  body: string
  createdAt: number
  fileId?: string
  fileName?: string
  fileMime?: string
}

export type Theme = 'dark' | 'light'

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export type Phase = 'boot' | 'join' | 'chat'
export type ToastKind = 'info' | 'warning' | 'error'
export type Connection = 'connecting' | 'online' | 'offline'

export interface AppState {
  phase: Phase
  connection: Connection
  /** True once a welcome has been received this session (server was reached). */
  hasConnected: boolean
  /** Live public settings (Wi-Fi SSID, voice availability). */
  config: PublicConfig
  me: User | null
  users: Record<string, User>
  channels: Record<string, Channel>
  online: Record<string, boolean>
  /**
   * The crew member a vision desk has cut to, if any.
   *
   * Shell state because it is the event's, not a module's, and because the
   * person it names is the one who most needs to be told without going
   * looking for it.
   */
  onAir: string | null
  /** Online with no on-site connection — joining from the office/warehouse. */
  remoteUsers: Record<string, boolean>
  readState: Record<string, number>
  /** Highest seq per channel that @-mentions me; unseen when > readState. */
  mentionSeqs: Record<string, number>
  messages: Record<string, Message[]>
  /**
   * The show log, as one flat list. Not per-channel like messages: there is
   * one show and one log, and the pane arranges it (see modules/incident).
   */
  incidents: Incident[]
  /** True once the scrollback has been fetched at least once. */
  incidentsLoaded: boolean
  pending: Record<string, Pending[]>
  typing: Record<string, Record<string, number>>
  activeChannelId: string | null
  /** Module owning the main pane (/m/<id> routes); null = chat view. */
  activeModuleId: string | null
  /** Subpath within the active module's routes ('' at the module root). */
  activeModuleSubpath: string
  /** Message to scroll to and flash once rendered (set by search jumps). */
  jumpTarget: { channelId: string; seq: number } | null
  /**
   * Channels whose in-memory messages are an old context block, detached
   * from the live tail (after a far-back search jump). The list shows a
   * persistent "Jump to latest" pill and suppresses read-marking until
   * returnToLatest() replaces the block with the real tail.
   */
  historyGapped: Record<string, boolean>
  /**
   * What the lighting network is doing, when a view has asked to watch it.
   *
   * Ephemeral and never cached: it describes a network this device is not on
   * and a moment that has already passed. `everLit` and `levels` are decoded
   * once here rather than in every component that reads them.
   */
  dmx: {
    /** False until the box says otherwise, including when it isn't listening. */
    listening: boolean
    universes: DmxUniverseWire[]
    /** universe → 64-byte bitmap of addresses ever above zero. */
    everLit: Map<number, Uint8Array>
    /** universe → 512 current levels. Only populated when levels were asked for. */
    levels: Map<number, Uint8Array>
  }
  /** DM the user asked to open; activated when the channel arrives. */
  pendingDmUserId: string | null
  sidebarOpen: boolean
  searchOpen: boolean
  adminOpen: boolean
  /**
   * Proof that someone typed the admin password, for this run of the app.
   *
   * Deliberately never written to localStorage or the IndexedDB snapshot. The
   * session token is persisted so crew stay signed in for weeks; this one has
   * to die when the app closes, which is exactly what keeping it in memory
   * gets us for free.
   */
  adminToken: string | null
  audioSettingsOpen: boolean
  /** File message whose detail modal is open; null when closed. */
  fileDetail: Message | null
  /** Rolling median WS round-trip in ms; null while unknown/offline. */
  latencyMs: number | null
  /** A newer build is available; show the reload pill. */
  updateReady: boolean
  /** Transient notices; each auto-dismisses on its own timer. */
  toasts: { id: number; message: string; kind: ToastKind }[]
  loadingOlder: boolean
  uploading: boolean
  theme: Theme
  sounds: boolean
  voice: VoiceState

  boot: () => Promise<void>
  joinVoice: (channelId: string) => Promise<void>
  leaveVoice: () => Promise<void>
  setTalking: (on: boolean) => void
  toggleLatch: () => void
  /** Let blocked audio through. Must be called from a real user gesture. */
  resumeVoiceAudio: () => void
  join: (name: string, eventPin: string, personalPin: string) => Promise<void>
  sendMessage: (channelId: string, body: string) => void
  /** File a show-log entry. Queued locally first, so nothing is lost offline. */
  logIncident: (entry: Omit<QueuedIncident, 'clientMsgId'>) => void
  /** Fetch the log's scrollback. Idempotent; the pane calls it on open. */
  loadIncidents: () => Promise<void>
  sendFile: (channelId: string, file: File, caption?: string) => Promise<void>
  sendTyping: (channelId: string) => void
  setActiveChannel: (channelId: string) => void
  /** Open a module view (sidebar tap / in-module nav); pushes /m/<id>[/<subpath>]. */
  setActiveModule: (moduleId: string, subpath?: string) => void
  /** Apply a route from the URL (back/forward, initial load) to state. */
  applyRoute: (route: Route) => void
  /** Show a transient notice; auto-dismisses after a few seconds. */
  toast: (message: string, kind?: ToastKind) => void
  /** Open a channel scrolled to a specific message (search results). */
  jumpToMessage: (channelId: string, seq: number) => Promise<void>
  clearJumpTarget: () => void
  /** Leave a gapped history view: refetch and show the channel's live tail. */
  returnToLatest: (channelId: string) => Promise<void>
  openDm: (userId: string) => void
  createChannel: (name: string, topic: string) => void
  loadOlder: (channelId: string) => Promise<void>
  /**
   * Ask the box about these universes. `[]` stops watching.
   *
   * Levels are opt-in because they are the expensive half — most of the value
   * (is it arriving, does the patch match) needs none.
   */
  watchDmx: (universes: number[], levels?: boolean) => void
  markChannelRead: (channelId: string) => void
  setSidebarOpen: (open: boolean) => void
  setSearchOpen: (open: boolean) => void
  setAdminOpen: (open: boolean) => void
  /** Trade the admin password for a token; throws with the server's message. */
  unlockAdmin: (password: string) => Promise<void>
  /** Give the unlock back — the panel's Lock button, and any 403 it meets. */
  lockAdmin: () => void
  /**
   * Replace the unlock token. Changing the admin password revokes every
   * token including this device's, and the server hands back a replacement
   * so the admin who made the change isn't thrown out by their own edit.
   */
  setAdminToken: (adminToken: string) => void
  setAudioSettingsOpen: (open: boolean) => void
  openFileDetail: (message: Message) => void
  closeFileDetail: () => void
  setAudioDevice: (kind: 'audioinput' | 'audiooutput', deviceId: string | null) => void
  applyUpdate: () => void
  retryConnection: () => void
  toggleTheme: () => void
  toggleSounds: () => void
  logout: () => Promise<void>
  deleteAccount: () => Promise<void>
}

let ws: WsClient | null = null
/**
 * The lighting-network watch this client currently wants, so it can be
 * re-established after a websocket reconnect. The subscription lives on the
 * server *connection*; a reconnect is a fresh connection with no watch, and
 * without re-sending it the live bar keeps painting the last levels it saw —
 * a desk that has actually stopped reaching this phone shown as live.
 */
let dmxWatch: { universes: number[]; levels: boolean } = { universes: [], levels: false }
/** Lazily constructed — importing it pulls the LiveKit SDK chunk. */
let voiceManager: VoiceManager | null = null
/** Reloads into the new service worker; set once PWA registration runs. */
let updateSW: ((reload?: boolean) => Promise<void>) | null = null
let pwaStarted = false
const lastTypingSent = new Map<string, number>()
let toastSeq = 0

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

/** The crewbox session token, for modules that call platform services. */
export function sessionToken(): string | null {
  return getToken()
}

function mergeMessages(existing: Message[] | undefined, incoming: Message[]): Message[] {
  const sorted = [...incoming].sort((a, b) => a.seq - b.seq)
  if (!existing?.length) return sorted
  // Fast path — live traffic is strictly newer than everything we hold, so
  // don't rebuild and re-sort the whole channel per arriving message.
  if (sorted[0]!.seq > existing.at(-1)!.seq) return [...existing, ...sorted]
  const byId = new Map(existing.map((m) => [m.id, m]))
  for (const m of sorted) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

export const useStore = create<AppState>()((set, get) => {
  /** Merge messages into state, settle matching pending sends, update cache. */
  function ingestMessages(incoming: Message[]): void {
    if (!incoming.length) return
    const state = get()
    const messages = { ...state.messages }
    const pending = { ...state.pending }
    const channels = { ...state.channels }
    const settled = new Set(incoming.filter((m) => m.clientMsgId).map((m) => m.clientMsgId!))

    // Track the newest @mention of me per channel for the sidebar badges.
    const mentionSeqs = { ...state.mentionSeqs }
    let mentionsChanged = false
    for (const m of incoming) {
      if (!m.authorId || m.authorId === state.me?.id) continue
      if (isMentioned(m.body, state.me?.name) && m.seq > (mentionSeqs[m.channelId] ?? 0)) {
        mentionSeqs[m.channelId] = m.seq
        mentionsChanged = true
      }
    }

    const byChannel = new Map<string, Message[]>()
    for (const m of incoming) {
      const list = byChannel.get(m.channelId) ?? []
      list.push(m)
      byChannel.set(m.channelId, list)
    }
    for (const [channelId, list] of byChannel) {
      // While a channel shows a detached search-jump block (historyGapped),
      // don't splice live traffic onto it — that would render a brand-new
      // message directly under days-old context with no gap marker. The
      // block stays intact; returnToLatest refetches the real tail. We still
      // bump lastSeq (so the "Jump to latest" pill and unread counts update)
      // and cache below (the cache holds the true contiguous tail, untouched
      // by the gapped view).
      if (!state.historyGapped[channelId]) {
        messages[channelId] = mergeMessages(messages[channelId], list)
      }
      const incomingMax = list.reduce((mx, m) => Math.max(mx, m.seq), 0)
      const lastSeq = Math.max(incomingMax, messages[channelId]?.at(-1)?.seq ?? 0)
      const channel = channels[channelId]
      if (channel && lastSeq > channel.lastSeq) {
        channels[channelId] = { ...channel, lastSeq }
      }
      if (pending[channelId]?.some((p) => settled.has(p.clientMsgId))) {
        pending[channelId] = pending[channelId].filter((p) => !settled.has(p.clientMsgId))
      }
    }
    set(
      mentionsChanged
        ? { messages, pending, channels, mentionSeqs }
        : { messages, pending, channels }
    )
    if (mentionsChanged) schedulePersistSnapshot()
    for (const clientMsgId of settled) void cache.deleteOutbox(clientMsgId)
    void cache.saveMessages(incoming)
  }

  /** Drop deleted messages from state and cache (live broadcast + welcome). */
  function applyDeletions(deletions: { channelId: string; messageId: string }[]): void {
    if (!deletions.length) return
    const ids = new Set(deletions.map((d) => d.messageId))
    const messages = { ...get().messages }
    let changed = false
    for (const { channelId } of deletions) {
      const list = messages[channelId]
      if (!list?.some((m) => ids.has(m.id))) continue
      messages[channelId] = list.filter((m) => !ids.has(m.id))
      changed = true
    }
    if (changed) set({ messages })
    const openDetail = get().fileDetail
    if (openDetail && ids.has(openDetail.id)) set({ fileDetail: null })
    void cache.deleteMessages([...ids])
  }

  function persistSnapshot(): void {
    const { me, users, channels, readState, mentionSeqs } = get()
    void cache.saveSnapshot({
      me,
      users: Object.values(users),
      channels: Object.values(channels),
      readState,
      mentionSeqs,
    })
  }

  // Coalesce snapshot writes on a trailing timer: a burst of @mentions (or an
  // @all) would otherwise re-serialize the whole users+channels roster into
  // IndexedDB per message on low-end phones.
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null
  function schedulePersistSnapshot(): void {
    if (snapshotTimer) return
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null
      persistSnapshot()
    }, 1000)
  }

  function markRead(channelId: string, seq: number): void {
    const current = get().readState[channelId] ?? 0
    if (seq <= current) return
    set({ readState: { ...get().readState, [channelId]: seq } })
    ws?.send({ type: 'markRead', channelId, seq })
    persistSnapshot()
  }

  async function handleWelcome(msg: WelcomeMessage): Promise<void> {
    const state = get()

    // Local read state may be ahead (user read messages while offline).
    const readState: Record<string, number> = { ...msg.readState }
    for (const [channelId, seq] of Object.entries(state.readState)) {
      if (seq > (readState[channelId] ?? 0)) {
        readState[channelId] = seq
        ws?.send({ type: 'markRead', channelId, seq })
      }
    }

    // Server redeployed to a newer build while we were connected: surface the
    // reload pill. Guarded by an active service worker so dev (no SW) and any
    // transient mismatch don't nag; the SW's own onNeedRefresh is the primary
    // trigger, this just makes reconnect-after-redeploy instant.
    if (
      msg.serverVersion &&
      msg.serverVersion !== APP_VERSION &&
      typeof navigator !== 'undefined' &&
      navigator.serviceWorker?.controller
    ) {
      set({ updateReady: true })
      // Kick the SW to fetch the new build now, so the pill we just raised
      // isn't a dead button until the next 30-minute periodic check.
      checkForUpdate()
    }

    // Channels where the replay was truncated have a gap between our cache
    // and the replayed batch — drop the stale cache, keep only the fresh tail.
    const messages = { ...state.messages }
    for (const channelId of msg.truncated) {
      messages[channelId] = []
      void cache.clearChannel(channelId)
    }

    rememberConfig(msg.config)
    set({
      phase: 'chat',
      connection: 'online',
      hasConnected: true,
      config: msg.config,
      me: msg.me,
      users: Object.fromEntries(msg.users.map((u) => [u.id, u])),
      channels: Object.fromEntries(msg.channels.map((c) => [c.id, c])),
      online: Object.fromEntries(msg.online.map((id) => [id, true])),
      remoteUsers: Object.fromEntries((msg.remote ?? []).map((id) => [id, true])),
      readState,
      messages,
      // Replay (or the truncated-channel reset) heals any search-jump gap.
      historyGapped: {},
    })
    ingestMessages(msg.missed)
    // Messages deleted while we were away must leave state and cache too.
    applyDeletions(msg.deletions ?? [])

    // Android wrapper: hand the session to the foreground service so the
    // phone buzzes for messages while the app is backgrounded or locked.
    const alerts = nativeAlerts()
    if (alerts && serverOrigin()) {
      void alerts
        .start({ serverUrl: serverOrigin(), token: getToken() ?? '', myName: msg.me.name })
        .catch(() => {})
    }

    // Re-establish the lighting-network watch on this fresh connection. The
    // server tracks the subscription per connection, so a reconnect starts
    // with none; without this the live bar keeps showing the levels from
    // before the drop as though the desk were still reaching us.
    if (dmxWatch.universes.length > 0) {
      ws?.send({ type: 'dmxWatch', universes: dmxWatch.universes, levels: dmxWatch.levels })
    }

    if (!get().activeChannelId) {
      const route = currentRoute()
      const wanted =
        route.kind === 'channel' ? msg.channels.find((c) => c.id === route.channelId) : undefined
      const landing = wanted ?? msg.channels.find((c) => c.name === HOME_CHANNEL) ?? msg.channels[0]
      if (landing) {
        set({ activeChannelId: landing.id })
        if (get().activeModuleId === null) {
          navigate({ kind: 'channel', channelId: landing.id }, { replace: true })
        }
      }
    }

    // A protocol mismatch means this bundle predates the server (they deploy
    // in lockstep) — surface the reload pill immediately, and kick the SW so
    // the new worker is waiting by the time the pill is tapped.
    if (msg.protocolVersion !== undefined && msg.protocolVersion !== PROTOCOL_VERSION) {
      set({ updateReady: true })
      checkForUpdate()
    }
    // The channel on screen counts as read while the app is focused.
    const activeId = get().activeChannelId
    const activeChannel = activeId ? get().channels[activeId] : undefined
    if (activeChannel && document.hasFocus()) {
      markRead(activeChannel.id, activeChannel.lastSeq)
    }

    // Flush the outbox: everything unacked goes out again (server dedupes).
    const outbox = await cache.loadOutbox()
    for (const entry of outbox) {
      ws?.send({
        type: 'send',
        clientMsgId: entry.clientMsgId,
        channelId: entry.channelId,
        body: entry.body,
        fileId: entry.fileId,
      })
    }

    // The show log's own queue: entries typed with no signal, kept in
    // localStorage so they survive the phone giving up and reloading. The
    // box dedupes on clientMsgId, so re-sending one it already has is free.
    for (const entry of queuedIncidents()) ws?.send({ type: 'logIncident', ...entry })

    persistSnapshot()
    void cache.prune()
  }

  function handleServer(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        void handleWelcome(msg)
        break
      case 'dmxState': {
        const everLit = new Map<number, Uint8Array>()
        for (const universe of msg.universes) {
          if (!universe.everLit) continue
          const binary = atob(universe.everLit)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          everLit.set(universe.universe, bytes)
        }
        set((state) => ({
          dmx: { ...state.dmx, listening: msg.listening, universes: msg.universes, everLit },
        }))
        break
      }
      case 'dmxLevels': {
        set((state) => {
          const levels = new Map(state.dmx.levels)
          // A full message is a snapshot; anything else is a change list, so
          // the previous values have to survive it.
          const slots = msg.full
            ? new Uint8Array(512)
            : new Uint8Array(levels.get(msg.universe) ?? new Uint8Array(512))
          for (const [address, level] of msg.values) slots[address - 1] = level
          levels.set(msg.universe, slots)
          return { dmx: { ...state.dmx, levels } }
        })
        break
      }
      case 'incident': {
        // Upsert by id: the author gets their own entry back as the
        // acknowledgement, and a reconnect can replay one already held.
        set((state) => {
          const without = state.incidents.filter((e) => e.id !== msg.incident.id)
          return { incidents: [...without, msg.incident] }
        })
        if (msg.incident.clientMsgId) unqueueIncident(msg.incident.clientMsgId)
        break
      }
      case 'msg': {
        ingestMessages([msg.message])
        const { activeChannelId, typing, me, users, channels } = get()
        if (msg.message.authorId && typing[msg.message.channelId]?.[msg.message.authorId]) {
          const channelTyping = { ...typing[msg.message.channelId] }
          delete channelTyping[msg.message.authorId]
          set({ typing: { ...typing, [msg.message.channelId]: channelTyping } })
        }
        const viewing = msg.message.channelId === activeChannelId && document.hasFocus()
        if (viewing) {
          markRead(msg.message.channelId, msg.message.seq)
        } else if (msg.message.authorId && msg.message.authorId !== me?.id) {
          const channel = channels[msg.message.channelId]
          const author = users[msg.message.authorId]?.name ?? 'Someone'
          if (channel?.kind === 'dm' || isMentioned(msg.message.body, me?.name)) {
            playAlert()
            notify(
              channel?.kind === 'dm' ? author : `${author} in #${channel?.name ?? 'channel'}`,
              msg.message.body || msg.message.file?.name || ''
            )
          }
        }
        break
      }
      case 'ack':
        ingestMessages([msg.message])
        // Your own message is read by definition.
        markRead(msg.message.channelId, msg.message.seq)
        break
      case 'rejected': {
        const pending = { ...get().pending }
        for (const channelId of Object.keys(pending)) {
          pending[channelId] = pending[channelId].filter((p) => p.clientMsgId !== msg.clientMsgId)
        }
        set({ pending })
        get().toast(`Message not delivered: ${msg.reason}`)
        void cache.deleteOutbox(msg.clientMsgId)
        break
      }
      case 'tally':
        set({ onAir: msg.userId })
        break
      case 'presence':
        set({
          online: { ...get().online, [msg.userId]: msg.online },
          remoteUsers: {
            ...get().remoteUsers,
            [msg.userId]: msg.online ? (msg.remote ?? false) : false,
          },
        })
        break
      case 'typing': {
        const typing = { ...get().typing }
        typing[msg.channelId] = {
          ...typing[msg.channelId],
          [msg.userId]: Date.now() + TYPING_TTL_MS,
        }
        set({ typing })
        break
      }
      case 'user':
        set({ users: { ...get().users, [msg.user.id]: msg.user } })
        persistSnapshot()
        break
      case 'channel': {
        set({ channels: { ...get().channels, [msg.channel.id]: msg.channel } })
        // A retired channel disappears; move anyone looking at it home.
        if (msg.channel.retired && get().activeChannelId === msg.channel.id) {
          const fallback = Object.values(get().channels).find(
            (c) => c.name === HOME_CHANNEL && !c.retired
          )
          set({ activeChannelId: fallback?.id ?? null })
          if (fallback && get().activeModuleId === null) {
            navigate({ kind: 'channel', channelId: fallback.id }, { replace: true })
          }
        }
        const { pendingDmUserId, me } = get()
        if (
          pendingDmUserId &&
          msg.channel.kind === 'dm' &&
          msg.channel.memberIds?.includes(pendingDmUserId) &&
          msg.channel.memberIds.includes(me?.id ?? '')
        ) {
          navigate({ kind: 'channel', channelId: msg.channel.id })
          set({ activeChannelId: msg.channel.id, pendingDmUserId: null, sidebarOpen: false })
        }
        persistSnapshot()
        break
      }
      case 'readState': {
        const current = get().readState[msg.channelId] ?? 0
        if (msg.seq > current) {
          set({ readState: { ...get().readState, [msg.channelId]: msg.seq } })
        }
        break
      }
      case 'pong':
        break
      case 'config':
        rememberConfig(msg.config)
        set({ config: msg.config })
        break
      case 'deleted':
        applyDeletions([{ channelId: msg.channelId, messageId: msg.messageId }])
        break
      case 'error':
        if (msg.code === 'auth') {
          void get().logout()
        } else {
          get().toast(msg.message)
        }
        break
    }
  }

  function startWs(): void {
    if (ws) return
    ws = new WsClient({
      hello: () => {
        const cursors: Record<string, number> = {}
        for (const [channelId, list] of Object.entries(get().messages)) {
          const last = list.at(-1)
          if (last) cursors[channelId] = last.seq
        }
        return { token: getToken() ?? '', cursors }
      },
      onMessage: handleServer,
      onStatus: (status) => set({ connection: status }),
      onLatency: (ms) => set({ latencyMs: ms }),
    })
    ws.start()
  }

  return {
    phase: 'boot',
    connection: 'connecting',
    hasConnected: false,
    config: initialConfig(),
    fileDetail: null,
    me: null,
    users: {},
    channels: {},
    online: {},
    onAir: null,
    remoteUsers: {},
    readState: {},
    mentionSeqs: {},
    messages: {},
    incidents: [],
    incidentsLoaded: false,
    pending: {},
    typing: {},
    activeChannelId: null,
    activeModuleId: null,
    activeModuleSubpath: '',
    jumpTarget: null,
    historyGapped: {},
    dmx: { listening: false, universes: [], everLit: new Map(), levels: new Map() },
    pendingDmUserId: null,
    sidebarOpen: false,
    searchOpen: false,
    adminOpen: false,
    adminToken: null,
    audioSettingsOpen: false,
    latencyMs: null,
    updateReady: false,
    toasts: [],
    loadingOlder: false,
    uploading: false,
    theme: initialTheme(),
    sounds: soundsEnabled(),
    voice: initialVoiceState,

    async joinVoice(channelId) {
      if (!voiceManager) {
        // First use: load the voice module (and the LiveKit SDK) on demand.
        const { VoiceManager } = await import('./lib/voice.ts')
        voiceManager ??= new VoiceManager(
          (partial) => set({ voice: { ...useStore.getState().voice, ...partial } }),
          (message) => get().toast(message, 'warning'),
          // Straight out over the chat socket, which is already open and
          // already carries the other thing only a device can measure (its
          // own round trip). Dropped without complaint when the socket is
          // down: this is a graph, and a graph is never worth a retry queue.
          (qos) =>
            ws?.send({
              type: 'voiceStats',
              lossPct: qos.lossPct,
              jitterMs: qos.jitterMs,
              concealedPct: qos.concealedPct,
            })
        )
      }
      // Browsers only hand over a microphone in a secure context, and a box
      // on a plain http:// LAN address is not one. Said up front because the
      // alternative is someone holding a talk button that was never going to
      // work and concluding the product is broken. Not a blocker: listening
      // needs no microphone, and hearing the others is most of the value.
      if (!window.isSecureContext) {
        get().toast(
          'No microphone on plain http — you can hear others but not talk. ' +
            'Open the box at localhost on the machine running it, or give it a certificate.',
          'warning'
        )
      }
      try {
        const { url, token } = await api.voiceToken(getToken() ?? '', channelId)
        await voiceManager.join(channelId, token, url)
      } catch (err) {
        set({ voice: { ...initialVoiceState } })
        // Say what actually went wrong. This used to substitute a generic
        // "is the voice server running?" for every failure, which is the
        // least useful sentence available: the voice bar unmounts on failure
        // and takes its own error with it, so this toast was the only thing
        // left, and it named none of the several things that can break here.
        const detail =
          err instanceof api.ApiError && err.status === 503
            ? 'this box has no voice server'
            : err instanceof Error
              ? err.message
              : String(err)
        get().toast(`Could not join voice: ${detail}`, 'error')
      }
    },

    async leaveVoice() {
      await voiceManager?.leave()
    },

    resumeVoiceAudio() {
      void voiceManager?.resumeAudio()
    },

    setTalking(on) {
      if (get().voice.latched && !on) return // latch holds the mic open
      void voiceManager?.setTalking(on)
    },

    toggleLatch() {
      const latched = !get().voice.latched
      set({ voice: { ...get().voice, latched } })
      void voiceManager?.setTalking(latched)
    },

    async boot() {
      // Register the service worker once, regardless of auth phase. Native
      // wrappers ship the bundle in the app package — no SW wanted there.
      if (!pwaStarted && !isNative()) {
        pwaStarted = true
        try {
          updateSW = initPwa(() => set({ updateReady: true }))
        } catch {
          // no service worker support (or dev without PWA) — updates via reload
        }
      }
      // Public config (Wi-Fi SSID, voice availability) — works pre-auth so the
      // join and offline screens can show current guidance. Best-effort.
      void api
        .getConfig()
        .then((config) => {
          rememberConfig(config)
          set({ config })
        })
        .catch(() => {})
      if (!getToken()) {
        set({ phase: 'join' })
        return
      }
      // Hydrate from the local cache first so the app is usable instantly
      // (and offline); the welcome payload reconciles once connected.
      const [snapshot, cachedMessages, outbox] = await Promise.all([
        cache.loadSnapshot(),
        cache.loadMessages(),
        cache.loadOutbox(),
      ])
      const messages: Record<string, Message[]> = {}
      for (const m of cachedMessages) {
        ;(messages[m.channelId] ??= []).push(m)
      }
      const pending: Record<string, Pending[]> = {}
      for (const entry of outbox) {
        ;(pending[entry.channelId] ??= []).push(entry)
      }
      set({
        phase: 'chat',
        messages,
        pending,
        me: snapshot?.me ?? null,
        users: Object.fromEntries((snapshot?.users ?? []).map((u) => [u.id, u])),
        channels: Object.fromEntries((snapshot?.channels ?? []).map((c) => [c.id, c])),
        readState: snapshot?.readState ?? {},
        mentionSeqs: snapshot?.mentionSeqs ?? {},
      })
      const route = currentRoute()
      const cachedChannels = snapshot?.channels ?? []
      const wanted =
        route.kind === 'channel' ? cachedChannels.find((c) => c.id === route.channelId) : undefined
      const landing = wanted ?? cachedChannels.find((c) => c.name === HOME_CHANNEL)
      if (landing) set({ activeChannelId: landing.id })
      if (route.kind === 'module') {
        set({ activeModuleId: route.moduleId, activeModuleSubpath: route.subpath })
      }
      startWs()
    },

    async join(name, eventPin, personalPin) {
      const { token } = await api.join({ name, eventPin, personalPin })
      localStorage.setItem(TOKEN_KEY, token)
      requestNotificationPermission()
      await get().boot()
    },

    sendMessage(channelId, body) {
      const trimmed = body.trim()
      if (!trimmed) return
      const entry: OutboxEntry = {
        clientMsgId: newId(),
        channelId,
        body: trimmed,
        createdAt: Date.now(),
      }
      void cache.putOutbox(entry)
      const pending = { ...get().pending }
      pending[channelId] = [...(pending[channelId] ?? []), entry]
      set({ pending })
      ws?.send({ type: 'send', clientMsgId: entry.clientMsgId, channelId, body: trimmed })
    },

    logIncident(entry) {
      const body = entry.body.trim()
      if (!body) return
      const queued = { ...entry, body, clientMsgId: newId() }
      // Queued before it is sent, never after: the tap that files a show stop
      // has to survive the screen going dark a moment later.
      queueIncident(queued)
      ws?.send({ type: 'logIncident', ...queued })
    },

    async loadIncidents() {
      try {
        const { incidents } = await api.fetchIncidents(getToken() ?? '')
        set((state) => {
          // Merge rather than replace: live entries may have arrived while
          // this was in flight, and the author's own unacked ones are held
          // in the queue rather than here.
          const byId = new Map(state.incidents.map((e) => [e.id, e]))
          for (const entry of incidents) byId.set(entry.id, entry)
          return { incidents: [...byId.values()], incidentsLoaded: true }
        })
      } catch {
        // Offline, or a box with the module off. The pane says so rather
        // than spinning, and whatever is already in memory still shows.
        set({ incidentsLoaded: true })
      }
    },

    async sendFile(channelId, file, caption = '') {
      if (get().connection !== 'online') {
        get().toast('Attachments need a connection — try again once reconnected')
        return
      }
      set({ uploading: true })
      try {
        const image = await measureImage(file)
        const { file: meta } = await api.uploadFile(getToken() ?? '', file, image ?? undefined)
        const entry: OutboxEntry = {
          clientMsgId: newId(),
          channelId,
          body: caption.trim(),
          createdAt: Date.now(),
          fileId: meta.id,
          fileName: meta.name,
          fileMime: meta.mime,
        }
        void cache.putOutbox(entry)
        const pending = { ...get().pending }
        pending[channelId] = [...(pending[channelId] ?? []), entry]
        set({ pending })
        ws?.send({
          type: 'send',
          clientMsgId: entry.clientMsgId,
          channelId,
          body: entry.body,
          fileId: meta.id,
        })
      } catch (err) {
        get().toast(err instanceof api.ApiError ? err.message : 'Upload failed')
      } finally {
        set({ uploading: false })
      }
    },

    sendTyping(channelId) {
      const last = lastTypingSent.get(channelId) ?? 0
      if (Date.now() - last < TYPING_THROTTLE_MS) return
      lastTypingSent.set(channelId, Date.now())
      ws?.send({ type: 'typing', channelId })
    },

    setActiveChannel(channelId) {
      navigate({ kind: 'channel', channelId })
      set({ activeChannelId: channelId, activeModuleId: null, sidebarOpen: false })
      get().markChannelRead(channelId)
    },

    setActiveModule(moduleId, subpath = '') {
      navigate({ kind: 'module', moduleId, subpath })
      set({ activeModuleId: moduleId, activeModuleSubpath: subpath, sidebarOpen: false })
    },

    applyRoute(route) {
      switch (route.kind) {
        case 'channel': {
          // Unknown id (deleted channel, stale link): fall back to the
          // default view rather than rendering a dead pane.
          if (!get().channels[route.channelId]) {
            set({ activeModuleId: null })
            return
          }
          set({ activeChannelId: route.channelId, activeModuleId: null })
          get().markChannelRead(route.channelId)
          return
        }
        case 'module':
          set({ activeModuleId: route.moduleId, activeModuleSubpath: route.subpath })
          return
        case 'home':
          set({ activeModuleId: null })
          return
      }
    },

    toast(message, kind = 'error') {
      const id = ++toastSeq
      set({ toasts: [...get().toasts, { id, message, kind }] })
      // Per-toast timer — a second toast must not cut the first one short.
      setTimeout(() => {
        set({ toasts: get().toasts.filter((toast) => toast.id !== id) })
      }, 5000)
    },

    async jumpToMessage(channelId, seq) {
      set({ searchOpen: false })
      const held = get().messages[channelId] ?? []
      if (!held.some((m) => m.seq === seq)) {
        let ctx: Message[]
        try {
          ;({ messages: ctx } = await api.fetchContext(getToken() ?? '', channelId, seq))
        } catch {
          ctx = []
        }
        if (!ctx.some((m) => m.seq === seq)) {
          // Deleted or unreachable — open the channel normally instead.
          get().toast('That message is no longer available')
          get().setActiveChannel(channelId)
          return
        }
        const earliestHeld = held.find((m) => m.seq > 0)?.seq
        // Only a plain contiguous extension when we hold the live tail (not an
        // already-detached block) AND the context reaches it — otherwise
        // merging would splice a second hidden gap into the held block.
        if (
          !get().historyGapped[channelId] &&
          earliestHeld !== undefined &&
          ctx.at(-1)!.seq >= earliestHeld - 1
        ) {
          set({
            messages: {
              ...get().messages,
              [channelId]: mergeMessages(get().messages[channelId], ctx),
            },
          })
          void cache.saveMessages(ctx)
        } else {
          // Far-back block, detached from the live tail: show it alone and
          // flag the gap. Never cached — the cache stays a contiguous tail.
          const lastSeq = get().channels[channelId]?.lastSeq ?? Number.POSITIVE_INFINITY
          set({
            messages: { ...get().messages, [channelId]: ctx },
            historyGapped: { ...get().historyGapped, [channelId]: lastSeq > ctx.at(-1)!.seq },
          })
        }
      }
      navigate({ kind: 'channel', channelId })
      set({
        activeChannelId: channelId,
        activeModuleId: null,
        sidebarOpen: false,
        jumpTarget: { channelId, seq },
      })
      // Opening a channel normally marks it read (the old setActiveChannel
      // path did); preserve that for a contiguous jump. When gapped we're
      // viewing detached history, so leave unread state — the "Jump to
      // latest" pill signals there's newer traffic below.
      if (!get().historyGapped[channelId]) get().markChannelRead(channelId)
    },

    clearJumpTarget() {
      set({ jumpTarget: null })
    },

    async returnToLatest(channelId) {
      const lastSeq = get().channels[channelId]?.lastSeq ?? 0
      try {
        const { messages: tail } = await api.fetchHistory(getToken() ?? '', channelId, lastSeq + 1)
        const historyGapped = { ...get().historyGapped }
        delete historyGapped[channelId]
        set({ messages: { ...get().messages, [channelId]: tail }, historyGapped })
        await cache.clearChannel(channelId)
        void cache.saveMessages(tail)
        get().markChannelRead(channelId)
      } catch {
        get().toast('Could not load the latest messages — check the connection')
      }
    },

    openDm(userId) {
      const { channels, me } = get()
      const existing = Object.values(channels).find(
        (c) =>
          c.kind === 'dm' && c.memberIds?.includes(userId) && c.memberIds.includes(me?.id ?? '')
      )
      if (existing) {
        get().setActiveChannel(existing.id)
      } else {
        set({ pendingDmUserId: userId })
        ws?.send({ type: 'openDm', userId })
      }
    },

    createChannel(name, topic) {
      ws?.send({ type: 'createChannel', name, topic })
    },

    async loadOlder(channelId) {
      const { messages, loadingOlder } = get()
      const list = messages[channelId] ?? []
      const earliest = list.find((m) => m.seq > 0)
      if (loadingOlder || !earliest || earliest.seq <= 1) return
      set({ loadingOlder: true })
      try {
        const { messages: older } = await api.fetchHistory(
          getToken() ?? '',
          channelId,
          earliest.seq
        )
        if (older.length) {
          set({
            messages: {
              ...get().messages,
              [channelId]: mergeMessages(get().messages[channelId], older),
            },
          })
          void cache.saveMessages(older)
        }
      } finally {
        set({ loadingOlder: false })
      }
    },

    markChannelRead(channelId) {
      const channel = get().channels[channelId]
      if (channel) markRead(channelId, channel.lastSeq)
    },

    setSidebarOpen(open) {
      set({ sidebarOpen: open })
    },

    watchDmx(universes, levels = false) {
      // Remembered so handleWelcome can re-arm it after a reconnect.
      dmxWatch = { universes, levels }
      ws?.send({ type: 'dmxWatch', universes, levels })
      if (universes.length === 0) {
        set({ dmx: { listening: false, universes: [], everLit: new Map(), levels: new Map() } })
      }
    },

    setSearchOpen(open) {
      set({ searchOpen: open })
    },

    setAdminOpen(open) {
      set({ adminOpen: open })
    },

    async unlockAdmin(password) {
      const { adminToken } = await api.adminUnlock(getToken() ?? '', password)
      set({ adminToken })
    },

    lockAdmin() {
      const adminToken = get().adminToken
      set({ adminToken: null, adminOpen: false })
      // Best effort: the token is already gone from this device, and the
      // server expires it anyway. A failed call must not keep the panel open.
      if (adminToken) void api.adminLock({ token: getToken() ?? '', adminToken }).catch(() => {})
    },

    setAdminToken(adminToken) {
      set({ adminToken })
    },

    setAudioSettingsOpen(open) {
      set({ audioSettingsOpen: open })
      if (open) {
        void voiceManager?.refreshDevices()
        void voiceManager?.startMicTest()
      } else {
        voiceManager?.stopMicTest()
      }
    },

    openFileDetail(message) {
      if (message.file) set({ fileDetail: message })
    },

    closeFileDetail() {
      set({ fileDetail: null })
    },

    setAudioDevice(kind, deviceId) {
      void voiceManager?.setDevice(kind, deviceId)
    },

    applyUpdate() {
      // Activate the waiting service worker and reload. Unsent messages are in
      // the IndexedDB outbox, so nothing is lost across the reload.
      if (updateSW) void updateSW(true)
      else location.reload()
    },

    retryConnection() {
      set({ connection: 'connecting' })
      if (ws) ws.reconnectNow()
      else startWs()
    },

    toggleTheme() {
      const theme: Theme = get().theme === 'dark' ? 'light' : 'dark'
      localStorage.setItem(THEME_KEY, theme)
      applyTheme(theme)
      set({ theme })
    },

    toggleSounds() {
      const sounds = !get().sounds
      setSoundsEnabled(sounds)
      set({ sounds })
    },

    async logout() {
      await voiceManager?.leave()
      void nativeAlerts()
        ?.stop()
        .catch(() => {})
      ws?.stop()
      ws = null
      localStorage.removeItem(TOKEN_KEY)
      await cache.wipe()
      location.reload()
    },

    async deleteAccount() {
      // Server-side removal first; if it fails, keep the account and surface it
      // rather than wiping the device while the account still exists.
      await api.deleteAccount(getToken() ?? '')
      await get().logout()
    },
  }
})

applyTheme(useStore.getState().theme)

// Back/forward buttons apply the URL to state (never push — the entry the
// user navigated to already exists).
onRouteChange((route) => useStore.getState().applyRoute(route))

// Test hook for driving the store from the browser console in dev.
if (import.meta.env.DEV) {
  ;(window as unknown as { __crewbox: typeof useStore }).__crewbox = useStore
}

/** Unread count for a channel, given current read state. */
export function unreadCount(channel: Channel, readState: Record<string, number>): number {
  return Math.max(0, channel.lastSeq - (channel.id in readState ? readState[channel.id]! : 0))
}

/** Display name for a channel (DMs show the other participant). */
export function channelLabel(
  channel: Channel,
  users: Record<string, User>,
  meId: string | undefined
): string {
  if (channel.kind !== 'dm') return channel.name
  const otherId = channel.memberIds?.find((id) => id !== meId) ?? channel.memberIds?.[0]
  return otherId ? (users[otherId]?.name ?? 'Unknown') : 'DM'
}
