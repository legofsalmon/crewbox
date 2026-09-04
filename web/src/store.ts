import { create } from 'zustand'
import {
  HOME_CHANNEL,
  newId,
  OUTBOX_FLUSH_GAP_MS,
  PROTOCOL_VERSION,
  type Channel,
  type ClientMessage,
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
  clearQueuedIncidents,
  queuedIncidents,
  unqueueIncident,
  type QueuedIncident,
} from './modules/incident/model/outbox.ts'
import { flushOrder, shouldDrop } from './lib/flush.ts'
import { cacheable, databaseChanged, needsBackfill, pageFrom } from './lib/history.ts'
import { WsClient } from './lib/ws.ts'
import * as api from './lib/api.ts'
import {
  isMentioned,
  notify,
  summariseMissed,
  playAlert,
  requestNotificationPermission,
  setSoundsEnabled,
  soundsEnabled,
} from './lib/alerts.ts'
import { initialVoiceState, type VoiceState } from './lib/voice-state.ts'
import type { VoiceManager } from './lib/voice.ts'
import { APP_VERSION, checkForUpdate, initPwa, knownBuild } from './lib/pwa.ts'
import { isNative, nativeAlerts, serverOrigin } from './lib/server.ts'
import { measureImage } from './lib/files.ts'
import { currentRoute, navigate, onRouteChange, type Route } from './shell/router.ts'

const TOKEN_KEY = 'crewbox:token'
const THEME_KEY = 'crewbox:theme'
const SSID_KEY = 'crewbox:wifi-ssid'
const EVENT_NAME_KEY = 'crewbox:event-name'
const MODULES_KEY = 'crewbox:modules'
/**
 * The database this phone's cached messages are numbered against.
 *
 * Reaches real devices — renaming it makes every phone on site drop its cache
 * once. See the epoch check in handleWelcome.
 */
const DB_EPOCH_KEY = 'crewbox:db-epoch'
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
  /**
   * True once a connection attempt has failed this session.
   *
   * Sticky while the app is still trying, so the recovery screen does not
   * flap with the retry backoff. Cleared by a welcome, which sets
   * `hasConnected` and takes the screen to 'ok' anyway.
   */
  hasFailed: boolean
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
   * Channels whose history has been paged back to its beginning.
   *
   * The scroll handler pages older whenever the oldest message on screen
   * has `seq > 1`, and deleting a channel's first message makes that true
   * for ever — so it fetched, got nothing, and fetched again on the very
   * next scroll event, for the life of the session. One empty answer is
   * enough to stop asking.
   */
  historyExhausted: Record<string, boolean>
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
  /** Give the unlock back and close the panel — the Lock button. */
  lockAdmin: () => void
  /**
   * The box has stopped honouring this unlock.
   *
   * A 403 from an admin route, which is a restart (unlocks live in one
   * process's memory), an expiry, or another admin changing the password.
   * The store's own comment said any 403 gave the unlock back, and nothing
   * did: every button went on failing with the same message and the only way
   * out was to reload the page.
   *
   * Unlike `lockAdmin` this leaves the panel open, so the unlock screen comes
   * up in its place rather than the whole thing vanishing under somebody who
   * did not ask for it to close. And it does not call `/api/admin/lock` —
   * the token being handed back is one the box has just refused.
   */
  adminUnlockLost: (reason: string) => void
  /** Why the panel locked itself, for the unlock screen to explain. */
  adminLockedReason: string | null
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
  /** The box says this session is dead. Keeps what has not been sent. */
  sessionEnded: () => Promise<void>
  deleteAccount: () => Promise<void>
}

let ws: WsClient | null = null

/**
 * Which outbox flush is the current one.
 *
 * A flush is paced over seconds, so a reconnect part-way through would
 * otherwise start a second one running alongside the first — at twice the
 * rate, into the flood guard the pacing exists to stay under. Each welcome
 * takes the next number; a flush stops the moment it is not the newest.
 */
let flushGeneration = 0

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

  /**
   * Fetch the tail of channels the welcome had no room for.
   *
   * The hub bounds the whole welcome with a global budget — twenty channels
   * at two hundred messages each, stringified on the event loop and pushed
   * over festival Wi-Fi to a hundred phones that all re-helloed when an
   * access point blipped, is not a frame anybody wants to send. Anything past
   * the budget comes back named in `truncated`, and the hub's comment says
   * "the client backfills those channels over REST on demand".
   *
   * No such code existed. The client cleared the channel and its cache, and
   * `loadOlder` pages backwards from the earliest message it holds — of which
   * there were none — so it refused to run. The channel sat there reading "No
   * messages yet" with an unread badge beside it until somebody posted
   * something new. Any phone joining a box with a few hundred messages across
   * its channels saw it.
   *
   * One request per channel and in order, because this is the same uplink the
   * welcome just came over and these are the channels nobody is looking at.
   */
  async function backfillTruncated(channelIds: readonly string[]): Promise<void> {
    for (const channelId of channelIds) {
      const channel = get().channels[channelId]
      if (!channel?.lastSeq) continue
      try {
        const { messages: tail } = await api.fetchHistory(
          getToken() ?? '',
          channelId,
          channel.lastSeq + 1
        )
        if (!tail.length) continue
        set({
          messages: {
            ...get().messages,
            [channelId]: mergeMessages(get().messages[channelId], tail),
          },
        })
        void cache.saveMessages(tail)
      } catch {
        // Offline, or the box is busy. `loadOlder` now covers the same ground
        // the moment somebody opens the channel, and the next welcome tries
        // again — neither is worth a banner about a channel nobody has looked
        // at yet.
      }
    }
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
    /** A welcome that is not this session's first — see the missed alert. */
    const reconnected = state.hasConnected

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
      // Only when both sides know which build they are. A tree with no git
      // (a release tarball) gives both a `+unknown` suffix, and comparing
      // two of those says nothing — it used to say "there is a new version"
      // about the build already running.
      knownBuild(msg.serverVersion) &&
      knownBuild(APP_VERSION) &&
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
    let messages = { ...state.messages }
    for (const channelId of msg.truncated) {
      messages[channelId] = []
      void cache.clearChannel(channelId)
    }

    // Is this the same database it was?
    //
    // A resume cursor is a bare sequence number and sequence numbers come
    // from `MAX(seq)` over live rows, so restoring a backup — or swapping to
    // the spare box — starts the count below every phone's cursor. Every
    // channel then looks like "nothing new" to the box and nothing to the
    // crew, silently, for as long as it takes the counter to climb past a
    // number nobody can see. The runbook promises phones "reconnect on their
    // own and stay signed in", and they do; they just stop being told
    // anything.
    //
    // Cached messages go with the cursors: they are numbered against a
    // database that is not here any more, and two messages at the same seq
    // are two different messages. The outbox stays — what somebody typed is
    // theirs, and the box dedupes the replay by client id.
    if (databaseChanged(localStorage.getItem(DB_EPOCH_KEY), msg.dbEpoch)) {
      messages = {}
      void cache.wipeMessagesOnly()
    }
    remember(DB_EPOCH_KEY, msg.dbEpoch)

    rememberConfig(msg.config)
    set({
      phase: 'chat',
      connection: 'online',
      hasConnected: true,
      hasFailed: false,
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
      // A welcome replays the tail; whether the top has been reached is a
      // question about this session's paging, not about the replay.
      historyExhausted: {},
    })
    ingestMessages(msg.missed)
    // Messages deleted while we were away must leave state and cache too.
    applyDeletions(msg.deletions ?? [])

    // Truncated channels that the replay left with nothing at all — the box
    // ran out of welcome budget before reaching them, so this phone holds no
    // message for them and cannot scroll to get one. See backfillTruncated.
    // A channel that was truncated but did get its tail is fine: `loadOlder`
    // pages back from what it has.
    const bare = needsBackfill(msg.truncated, get().messages)
    if (bare.length) void backfillTruncated(bare)

    // And say so, once, if any of them were for this crew member.
    //
    // The chirp lived only on the live `msg` path, so a DM that arrived
    // while the socket was up rang and one that arrived during an
    // access-point roam did not. On a site those are the same event from the
    // sender's side and the second is the one where somebody has been trying
    // for a while. `reconnected` is what keeps a cold app open quiet: a
    // phone somebody has just picked up and unlocked does not need telling
    // what is on its own screen.
    if (reconnected) {
      const focused = document.hasFocus() ? (get().activeChannelId ?? undefined) : undefined
      const alert = summariseMissed({
        missed: msg.missed,
        myId: msg.me.id,
        myName: msg.me.name,
        channels: get().channels,
        users: get().users,
        readState,
        focusedChannelId: focused,
      })
      if (alert) {
        playAlert()
        notify(alert.title, alert.body)
      }
    }

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
    //
    // Paced, because the box's flood guard counts frames per socket and does
    // not care that these are a replay: a phone back from a dead spot with
    // thirty-five queued messages sent all thirty-five at once and the box
    // refused five of them. The gap comes from the guard's own numbers (see
    // OUTBOX_FLUSH_GAP_MS) rather than a constant here that could drift away
    // from it.
    //
    // `generation` is what stops two flushes overlapping. A reconnect during
    // a flush would otherwise run a second one alongside the first, at twice
    // the rate, which is the thing being avoided.
    const mine = ++flushGeneration
    const paced = async (frames: ClientMessage[]): Promise<void> => {
      for (let i = 0; i < frames.length; i++) {
        // A drop mid-flush leaves the rest queued, which is where they
        // belong: the next welcome starts again from the outbox.
        if (mine !== flushGeneration || get().connection !== 'online') return
        ws?.send(frames[i]!)
        if (i < frames.length - 1) await sleep(OUTBOX_FLUSH_GAP_MS)
      }
    }

    const outbox = await cache.loadOutbox()
    // The show log's own queue goes through the same pacing, because it
    // shares the same counter — see flushOrder.
    void paced(flushOrder(outbox, queuedIncidents()))

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
        // `retry` means the box could not take it *now* — only the flood
        // guard says that. Deleting those was how a phone replaying an
        // outbox after a dead spot lost everything past the thirtieth, on
        // the screen that had just promised nothing would be. Keep it
        // queued, keep it on screen as pending, and say nothing: the flush
        // is paced now, so the next one gets through and a toast per message
        // would be thirty-five toasts about a delay nobody chose.
        if (!shouldDrop(msg)) break
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
          // The session really is dead — the box has said so about the token,
          // not about this socket. `handshake` is the other one, and sending
          // it as `auth` is what used to sign every phone out when the box was
          // short of disk. Falls through to the toast, which is right: the
          // socket reconnects and says hello again on its own.
          void get().sessionEnded()
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
      // `hasFailed` latches on the first failure and never clears while
      // this session is still trying — see connectionScreen. Without it a
      // cold start with no cache flapped between the recovery screen and
      // "Connecting…" on every backoff tick.
      onStatus: (status) =>
        set((state) => ({
          connection: status,
          hasFailed: state.hasFailed || status === 'offline',
        })),
      onLatency: (ms) => set({ latencyMs: ms }),
    })
    ws.start()
  }

  return {
    phase: 'boot',
    connection: 'connecting',
    hasConnected: false,
    hasFailed: false,
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
    historyExhausted: {},
    dmx: { listening: false, universes: [], everLit: new Map(), levels: new Map() },
    pendingDmUserId: null,
    sidebarOpen: false,
    searchOpen: false,
    adminOpen: false,
    adminToken: null,
    adminLockedReason: null,
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
      //
      // A browser that will not open IndexedDB answers as if it were empty
      // rather than rejecting — see lib/db.ts. This used to be an unguarded
      // `Promise.all` in a function `App.tsx` calls with `void`, so a private
      // window meant no join form, no socket and no message, for ever.
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
      const { messages, channels, loadingOlder } = get()
      const list = messages[channelId] ?? []
      const earliest = list.find((m) => m.seq > 0)
      // An empty channel is not the same as a channel with no history. A
      // welcome that ran out of budget leaves one behind, and this used to
      // refuse to run on it — which is how a channel with three hundred
      // messages in it showed "No messages yet" for ever. With nothing held,
      // page from the top.
      const before = pageFrom({
        earliestSeq: earliest?.seq,
        lastSeq: channels[channelId]?.lastSeq ?? 0,
        exhausted: get().historyExhausted[channelId] ?? false,
      })
      if (loadingOlder || before === null) return
      set({ loadingOlder: true })
      try {
        const { messages: older } = await api.fetchHistory(getToken() ?? '', channelId, before)
        if (older.length) {
          set({
            messages: {
              ...get().messages,
              [channelId]: mergeMessages(get().messages[channelId], older),
            },
          })
          // Not while the view is gapped.
          //
          // A search jump puts a detached block on screen — messages around
          // seq 400 with nothing between them and the cached tail. Paging
          // older from there fetches a block that is contiguous *with the
          // jump*, and writing it to the cache leaves a permanent hole:
          // after a reload the channel reads 1-50, 380-420, 900-1000 with
          // nothing saying anything is missing, and no scroll ever fills it.
          // On screen the block is still there and still useful; it is only
          // the durable copy that must stay honest.
          if (cacheable(get().historyGapped[channelId] ?? false)) void cache.saveMessages(older)
        } else {
          // Nothing came back, so there is nothing older. Remembered, or the
          // scroll handler asks again on every single scroll event once the
          // channel's first message has been deleted — `seq > 1` stays true
          // for ever and the fetch never stops.
          set({ historyExhausted: { ...get().historyExhausted, [channelId]: true } })
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
      // Opening is a fresh attempt: whatever locked the panel last time is
      // not what the unlock screen should be explaining now.
      set({ adminOpen: open, ...(open ? { adminLockedReason: null } : {}) })
    },

    async unlockAdmin(password) {
      const { adminToken } = await api.adminUnlock(getToken() ?? '', password)
      set({ adminToken, adminLockedReason: null })
    },

    adminUnlockLost(reason) {
      if (!get().adminToken) return
      set({ adminToken: null, adminLockedReason: reason })
    },

    lockAdmin() {
      const adminToken = get().adminToken
      set({ adminToken: null, adminOpen: false, adminLockedReason: null })
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

    /**
     * Somebody is handing this device on.
     *
     * Everything local goes, including the queues: a phone passed to the next
     * shift must not file the last person's show-log entries under the new
     * person's name, which is exactly what an incident queue surviving a
     * logout did.
     */
    async logout() {
      await voiceManager?.leave()
      void nativeAlerts()
        ?.stop()
        .catch(() => {})
      ws?.stop()
      ws = null
      localStorage.removeItem(TOKEN_KEY)
      clearQueuedIncidents()
      await cache.wipe()
      location.reload()
    },

    /**
     * The box says this session is no longer valid.
     *
     * Not the same as logging out, and it used to be treated as if it were.
     * The token has to go — it will not work again — but the messages and
     * show-log entries this crew member typed and has not managed to send are
     * still theirs, on their own phone, and they are about to re-join as
     * themselves on the same device. Wiping those was throwing away work
     * because a credential expired.
     *
     * The device-handover case is `logout`, which does wipe them, because
     * there the next person is somebody else.
     */
    async sessionEnded() {
      await voiceManager?.leave()
      void nativeAlerts()
        ?.stop()
        .catch(() => {})
      ws?.stop()
      ws = null
      localStorage.removeItem(TOKEN_KEY)
      // The cached messages are somebody's session and go; the outbox is
      // theirs to finish sending once they are back in.
      await cache.wipeExceptOutbox()
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
