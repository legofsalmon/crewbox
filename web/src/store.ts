import { create } from 'zustand'
import {
  newId,
  type Channel,
  type Message,
  type PublicConfig,
  type ServerMessage,
  type User,
  type WelcomeMessage,
} from '@inter/shared'
import { cache, type OutboxEntry } from './lib/db.ts'
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
import { APP_VERSION, initPwa } from './lib/pwa.ts'
import { isNative, nativeAlerts, serverOrigin } from './lib/server.ts'
import { measureImage } from './lib/files.ts'

const TOKEN_KEY = 'inter:token'
const THEME_KEY = 'inter:theme'
const SSID_KEY = 'inter:wifi-ssid'
const TYPING_TTL_MS = 4000
const TYPING_THROTTLE_MS = 2500

/** Last-known Wi-Fi SSID, cached so the offline recovery screen has it. */
function initialConfig(): PublicConfig {
  return { wifiSsid: localStorage.getItem(SSID_KEY) ?? '', voiceEnabled: true }
}

function rememberConfig(config: PublicConfig): void {
  if (config.wifiSsid) localStorage.setItem(SSID_KEY, config.wifiSsid)
  else localStorage.removeItem(SSID_KEY)
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
export type Connection = 'connecting' | 'online' | 'offline'

interface AppState {
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
  /** Online with no on-site connection — joining from the office/warehouse. */
  remoteUsers: Record<string, boolean>
  readState: Record<string, number>
  /** Highest seq per channel that @-mentions me; unseen when > readState. */
  mentionSeqs: Record<string, number>
  messages: Record<string, Message[]>
  pending: Record<string, Pending[]>
  typing: Record<string, Record<string, number>>
  activeChannelId: string | null
  /** Message to scroll to and flash once rendered (set by search jumps). */
  jumpTarget: { channelId: string; seq: number } | null
  /**
   * Channels whose in-memory messages are an old context block, detached
   * from the live tail (after a far-back search jump). The list shows a
   * persistent "Jump to latest" pill and suppresses read-marking until
   * returnToLatest() replaces the block with the real tail.
   */
  historyGapped: Record<string, boolean>
  /** DM the user asked to open; activated when the channel arrives. */
  pendingDmUserId: string | null
  sidebarOpen: boolean
  searchOpen: boolean
  adminOpen: boolean
  audioSettingsOpen: boolean
  /** File message whose detail modal is open; null when closed. */
  fileDetail: Message | null
  /** Rolling median WS round-trip in ms; null while unknown/offline. */
  latencyMs: number | null
  /** A newer build is available; show the reload pill. */
  updateReady: boolean
  flash: string | null
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
  join: (name: string, eventPin: string, personalPin: string) => Promise<void>
  sendMessage: (channelId: string, body: string) => void
  sendFile: (channelId: string, file: File, caption?: string) => Promise<void>
  sendTyping: (channelId: string) => void
  setActiveChannel: (channelId: string) => void
  /** Open a channel scrolled to a specific message (search results). */
  jumpToMessage: (channelId: string, seq: number) => Promise<void>
  clearJumpTarget: () => void
  /** Leave a gapped history view: refetch and show the channel's live tail. */
  returnToLatest: (channelId: string) => Promise<void>
  openDm: (userId: string) => void
  createChannel: (name: string, topic: string) => void
  loadOlder: (channelId: string) => Promise<void>
  markChannelRead: (channelId: string) => void
  setSidebarOpen: (open: boolean) => void
  setSearchOpen: (open: boolean) => void
  setAdminOpen: (open: boolean) => void
  setAudioSettingsOpen: (open: boolean) => void
  openFileDetail: (message: Message) => void
  closeFileDetail: () => void
  setAudioDevice: (kind: 'audioinput' | 'audiooutput', deviceId: string | null) => void
  applyUpdate: () => void
  retryConnection: () => void
  toggleTheme: () => void
  toggleSounds: () => void
  logout: () => Promise<void>
}

let ws: WsClient | null = null
/** Lazily constructed — importing it pulls the LiveKit SDK chunk. */
let voiceManager: VoiceManager | null = null
/** Reloads into the new service worker; set once PWA registration runs. */
let updateSW: ((reload?: boolean) => Promise<void>) | null = null
let pwaStarted = false
const lastTypingSent = new Map<string, number>()

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
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
    set(mentionsChanged ? { messages, pending, channels, mentionSeqs } : { messages, pending, channels })
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

    if (!get().activeChannelId) {
      const general = msg.channels.find((c) => c.name === 'general') ?? msg.channels[0]
      if (general) set({ activeChannelId: general.id })
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

    persistSnapshot()
    void cache.prune()
  }

  function handleServer(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        void handleWelcome(msg)
        break
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
              msg.message.body || msg.message.file?.name || '',
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
        set({ pending, flash: `Message not delivered: ${msg.reason}` })
        void cache.deleteOutbox(msg.clientMsgId)
        setTimeout(() => set({ flash: null }), 5000)
        break
      }
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
        typing[msg.channelId] = { ...typing[msg.channelId], [msg.userId]: Date.now() + TYPING_TTL_MS }
        set({ typing })
        break
      }
      case 'user':
        set({ users: { ...get().users, [msg.user.id]: msg.user } })
        persistSnapshot()
        break
      case 'channel': {
        set({ channels: { ...get().channels, [msg.channel.id]: msg.channel } })
        // A retired channel disappears; move anyone looking at it to #general.
        if (msg.channel.retired && get().activeChannelId === msg.channel.id) {
          const fallback = Object.values(get().channels).find(
            (c) => c.name === 'general' && !c.retired,
          )
          set({ activeChannelId: fallback?.id ?? null })
        }
        const { pendingDmUserId, me } = get()
        if (
          pendingDmUserId &&
          msg.channel.kind === 'dm' &&
          msg.channel.memberIds?.includes(pendingDmUserId) &&
          msg.channel.memberIds.includes(me?.id ?? '')
        ) {
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
          set({ flash: msg.message })
          setTimeout(() => set({ flash: null }), 5000)
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
    remoteUsers: {},
    readState: {},
    mentionSeqs: {},
    messages: {},
    pending: {},
    typing: {},
    activeChannelId: null,
    jumpTarget: null,
    historyGapped: {},
    pendingDmUserId: null,
    sidebarOpen: false,
    searchOpen: false,
    adminOpen: false,
    audioSettingsOpen: false,
    latencyMs: null,
    updateReady: false,
    flash: null,
    loadingOlder: false,
    uploading: false,
    theme: initialTheme(),
    sounds: soundsEnabled(),
    voice: initialVoiceState,

    async joinVoice(channelId) {
      if (!voiceManager) {
        // First use: load the voice module (and the LiveKit SDK) on demand.
        const { VoiceManager } = await import('./lib/voice.ts')
        voiceManager ??= new VoiceManager((partial) =>
          set({ voice: { ...useStore.getState().voice, ...partial } }),
        )
      }
      try {
        const { url, token } = await api.voiceToken(getToken() ?? '', channelId)
        await voiceManager.join(channelId, token, url)
      } catch (err) {
        set({
          voice: { ...initialVoiceState },
          flash:
            err instanceof api.ApiError && err.status === 503
              ? 'Voice is not set up on this server'
              : 'Could not join voice — is the voice server running?',
        })
        setTimeout(() => set({ flash: null }), 5000)
      }
    },

    async leaveVoice() {
      await voiceManager?.leave()
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
      const general = (snapshot?.channels ?? []).find((c) => c.name === 'general')
      if (general) set({ activeChannelId: general.id })
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

    async sendFile(channelId, file, caption = '') {
      if (get().connection !== 'online') {
        set({ flash: 'Attachments need a connection — try again once reconnected' })
        setTimeout(() => set({ flash: null }), 5000)
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
        set({ flash: err instanceof api.ApiError ? err.message : 'Upload failed' })
        setTimeout(() => set({ flash: null }), 5000)
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
      set({ activeChannelId: channelId, sidebarOpen: false })
      get().markChannelRead(channelId)
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
          set({ flash: 'That message is no longer available' })
          setTimeout(() => set({ flash: null }), 5000)
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
            messages: { ...get().messages, [channelId]: mergeMessages(get().messages[channelId], ctx) },
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
      set({ activeChannelId: channelId, sidebarOpen: false, jumpTarget: { channelId, seq } })
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
        set({ flash: 'Could not load the latest messages — check the connection' })
        setTimeout(() => set({ flash: null }), 5000)
      }
    },

    openDm(userId) {
      const { channels, me } = get()
      const existing = Object.values(channels).find(
        (c) => c.kind === 'dm' && c.memberIds?.includes(userId) && c.memberIds.includes(me?.id ?? ''),
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
        const { messages: older } = await api.fetchHistory(getToken() ?? '', channelId, earliest.seq)
        if (older.length) {
          set({
            messages: { ...get().messages, [channelId]: mergeMessages(get().messages[channelId], older) },
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

    setSearchOpen(open) {
      set({ searchOpen: open })
    },

    setAdminOpen(open) {
      set({ adminOpen: open })
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
      void nativeAlerts()?.stop().catch(() => {})
      ws?.stop()
      ws = null
      localStorage.removeItem(TOKEN_KEY)
      await cache.wipe()
      location.reload()
    },
  }
})

applyTheme(useStore.getState().theme)

// Total unread in the tab title so a glance at the phone/laptop shows it.
useStore.subscribe((state) => {
  let total = 0
  for (const channel of Object.values(state.channels)) {
    if (channel.retired) continue
    total += Math.max(0, channel.lastSeq - (state.readState[channel.id] ?? 0))
  }
  const title = total > 0 ? `(${total}) Inter` : 'Inter'
  if (document.title !== title) document.title = title
})

// Test hook for driving the store from the browser console in dev.
if (import.meta.env.DEV) {
  ;(window as unknown as { __inter: typeof useStore }).__inter = useStore
}

/** Unread count for a channel, given current read state. */
export function unreadCount(channel: Channel, readState: Record<string, number>): number {
  return Math.max(0, channel.lastSeq - (channel.id in readState ? readState[channel.id]! : 0))
}

/** Display name for a channel (DMs show the other participant). */
export function channelLabel(
  channel: Channel,
  users: Record<string, User>,
  meId: string | undefined,
): string {
  if (channel.kind !== 'dm') return channel.name
  const otherId = channel.memberIds?.find((id) => id !== meId) ?? channel.memberIds?.[0]
  return otherId ? (users[otherId]?.name ?? 'Unknown') : 'DM'
}
