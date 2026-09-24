// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, ClientMessage, Message, WelcomeMessage } from '@crewbox/shared'

/**
 * Somebody needs you while the app is open.
 *
 * The chirp and the buzz said so, and nothing said who or where: the system
 * notification is only for an app out of sight, and on a phone the channel
 * list whose badge would say is shut away in the drawer. The banner says it.
 *
 * The socket is stood in for; the store is the real one, loaded afresh per
 * test the way a page load evaluates it.
 */

let socket: { onMessage: (msg: unknown) => void } | null = null
const sent: ClientMessage[] = []

vi.mock('./lib/ws.ts', () => ({
  WsClient: class {
    constructor(handlers: { onMessage: (msg: unknown) => void }) {
      socket = { onMessage: handlers.onMessage }
    }
    start() {}
    stop() {}
    send(msg: ClientMessage) {
      sent.push(msg)
    }
    reconnectNow() {}
  },
}))

vi.mock('./lib/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api.ts')>()),
  // Never answers: the socket is what speaks.
  getConfig: () => new Promise(() => {}),
}))

const channel = (id: string, name: string, over: Partial<Channel> = {}): Channel => ({
  id,
  name,
  kind: 'public',
  topic: '',
  lastSeq: 0,
  createdAt: 1,
  ...over,
})

const CHANNELS = [
  channel('general', 'general'),
  channel('stage-2', 'stage-2'),
  channel('dm-alex', 'dm-alex', { kind: 'dm', memberIds: ['u1', 'alex'] }),
]

const welcome = (missed: Message[] = []): WelcomeMessage => ({
  type: 'welcome',
  serverVersion: 'test',
  config: {
    eventName: 'Harbour Fest',
    wifiSsid: '',
    voiceEnabled: false,
    modules: ['chat'],
    eventId: 'friday',
  },
  me: { id: 'u1', name: 'Jo', role: 'member', createdAt: 1 },
  users: [
    { id: 'u1', name: 'Jo', role: 'member', createdAt: 1 },
    { id: 'alex', name: 'Alex', role: 'member', createdAt: 1 },
  ],
  channels: CHANNELS,
  readState: {},
  online: [],
  missed,
  truncated: [],
  deletions: [],
  dbEpoch: 'friday',
})

let seq = 0
const message = (channelId: string, body: string, authorId = 'alex'): Message => ({
  id: `m${++seq}`,
  channelId,
  seq,
  authorId,
  kind: 'text',
  body,
  createdAt: Date.now(),
})

/** Let a promise chain run: the welcome handler awaits the cache. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function signedIn() {
  vi.resetModules()
  const { useStore } = await import('./store.ts')
  await useStore.getState().boot()
  socket!.onMessage(welcome())
  await settle()
  useStore.getState().setActiveChannel('general')
  return useStore
}

let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/')
  socket = null
  sent.length = 0
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  localStorage.setItem('crewbox:db-epoch', 'friday')
  localStorage.setItem('crewbox:token', 'a-sign-in')
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('a message that needs you, while the app is open', () => {
  it('says who, what and where, for a direct message', async () => {
    const store = await signedIn()
    socket!.onMessage({ type: 'msg', message: message('dm-alex', 'Can you come to FOH?') })
    expect(store.getState().alertBanner).toMatchObject({
      title: 'Alex',
      body: 'Can you come to FOH?',
      channelId: 'dm-alex',
    })
  })

  it('names the channel for a mention', async () => {
    const store = await signedIn()
    socket!.onMessage({ type: 'msg', message: message('stage-2', '@Jo the hazer is out') })
    expect(store.getState().alertBanner).toMatchObject({
      title: 'Alex in #stage-2',
      body: '@Jo the hazer is out',
      channelId: 'stage-2',
    })
  })

  it('says nothing for ordinary traffic, your own messages, or the channel on screen', async () => {
    const store = await signedIn()
    socket!.onMessage({ type: 'msg', message: message('stage-2', 'hazer is out') })
    socket!.onMessage({ type: 'msg', message: message('dm-alex', '@Jo note to self', 'u1') })
    store.getState().setActiveChannel('dm-alex')
    socket!.onMessage({ type: 'msg', message: message('dm-alex', 'Can you come to FOH?') })
    expect(store.getState().alertBanner).toBeNull()
  })

  it('is not left waiting for a phone that was out of sight', async () => {
    // The system's notification says it then, and a banner would be news
    // from however long ago when the phone is picked up.
    const store = await signedIn()
    visibility = 'hidden'
    socket!.onMessage({ type: 'msg', message: message('dm-alex', 'Can you come to FOH?') })
    expect(store.getState().alertBanner).toBeNull()
  })

  it('shows the latest, one at a time', async () => {
    const store = await signedIn()
    socket!.onMessage({ type: 'msg', message: message('dm-alex', 'Can you come to FOH?') })
    const first = store.getState().alertBanner!.id
    socket!.onMessage({ type: 'msg', message: message('stage-2', '@Jo never mind') })
    expect(store.getState().alertBanner).toMatchObject({ title: 'Alex in #stage-2' })
    // The first one's timer running out leaves the second alone.
    store.getState().dismissAlertBanner(first)
    expect(store.getState().alertBanner).toMatchObject({ title: 'Alex in #stage-2' })
  })

  it('announces what came in while the phone was out of signal', async () => {
    const store = await signedIn()
    socket!.onMessage(welcome([message('dm-alex', 'Where are you?')]))
    await settle()
    expect(store.getState().alertBanner).toMatchObject({
      title: 'Alex',
      body: 'Where are you?',
      channelId: 'dm-alex',
    })
  })
})

describe('tapping the banner', () => {
  it('opens the channel, out of whatever was open over it', async () => {
    const store = await signedIn()
    socket!.onMessage({ type: 'msg', message: message('dm-alex', 'Can you come to FOH?') })
    store.getState().setSearchOpen(true)
    store.getState().setAdminOpen(true)
    store.getState().setBoxesOpen(true)
    store.getState().openAlertBanner()
    const state = store.getState()
    expect(state.activeChannelId).toBe('dm-alex')
    expect(state.activeModuleId).toBeNull()
    expect([state.searchOpen, state.adminOpen, state.boxesOpen]).toEqual([false, false, false])
    expect(state.alertBanner).toBeNull()
    expect(location.pathname).toBe('/c/dm-alex')
  })

  it('opens the channel list when it covers more than one channel', async () => {
    const store = await signedIn()
    socket!.onMessage(
      welcome([message('dm-alex', 'Where are you?'), message('stage-2', '@Jo hazer')])
    )
    await settle()
    expect(store.getState().alertBanner).toMatchObject({ title: '2 messages need you' })
    store.getState().openAlertBanner()
    expect(store.getState().sidebarOpen).toBe(true)
    expect(store.getState().activeChannelId).toBe('general')
  })
})
