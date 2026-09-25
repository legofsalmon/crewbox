// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Alert,
  AlertSettings,
  Channel,
  ClientMessage,
  Message,
  WelcomeMessage,
} from '@crewbox/shared'

/**
 * A box that decides alerts (docs/ALERTS.md) is the one voice on what buzzes:
 * the page stops applying its own rules and says what the box sends, and a
 * person's channel levels and followed stages live on the box.
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

const welcome = (
  missed: Message[] = [],
  alertSettings: AlertSettings = { channels: {}, stages: [] }
): WelcomeMessage => ({
  type: 'welcome',
  serverVersion: 'test',
  config: {
    eventName: 'Harbour Fest',
    wifiSsid: '',
    voiceEnabled: false,
    modules: ['chat', 'incident', 'schedule'],
    eventId: 'friday',
    alerts: 1,
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
  alertSettings,
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

async function signedIn(settings?: AlertSettings) {
  vi.resetModules()
  const { useStore } = await import('./store.ts')
  await useStore.getState().boot()
  socket!.onMessage(welcome([], settings))
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

const alert = (over: Partial<Alert>): Alert => ({
  id: 'm:x',
  kind: 'mention',
  title: 'Alex in #stage-2',
  body: '@Jo hazer',
  target: { kind: 'channel', channelId: 'stage-2' },
  thread: 'channel:stage-2',
  quiet: false,
  urgent: false,
  at: Date.now(),
  ...over,
})

describe('on a box that decides alerts', () => {
  it('leaves the deciding to the box', async () => {
    const store = await signedIn()
    socket!.onMessage({ type: 'msg', message: message('stage-2', '@Jo the hazer is out') })
    expect(store.getState().alertBanner).toBeNull()
    socket!.onMessage({ type: 'alert', alert: alert({ body: '@Jo the hazer is out' }) })
    expect(store.getState().alertBanner).toMatchObject({
      title: 'Alex in #stage-2',
      body: '@Jo the hazer is out',
      channelId: 'stage-2',
    })
  })

  it('says nothing about the channel already on screen', async () => {
    const store = await signedIn()
    socket!.onMessage({
      type: 'alert',
      alert: alert({ target: { kind: 'channel', channelId: 'general' } }),
    })
    expect(store.getState().alertBanner).toBeNull()
  })

  it('opens the show log for a show stop, and the schedule for a changeover', async () => {
    const store = await signedIn()
    socket!.onMessage({
      type: 'alert',
      alert: alert({
        id: 'i:1',
        kind: 'showStop',
        title: 'Show stop on Main Stage',
        body: 'Sam: barrier',
        target: { kind: 'showlog' },
        thread: 'showlog',
        urgent: true,
      }),
    })
    expect(store.getState().alertBanner).toMatchObject({ title: 'Show stop on Main Stage' })
    store.getState().openAlertBanner()
    expect(store.getState().activeModuleId).toBe('incident')

    socket!.onMessage({
      type: 'alert',
      alert: alert({
        id: 'c:a:soon:2026-07-10:1290',
        kind: 'changeover',
        title: 'The Hollows on in 5 min',
        body: 'Main Stage',
        target: { kind: 'stage', stage: 'Main Stage' },
        thread: 'stage:Main Stage',
      }),
    })
    store.getState().openAlertBanner()
    expect(store.getState().activeModuleId).toBe('schedule')
  })

  it("holds the person's settings, and changes them at once and on the box", async () => {
    const store = await signedIn({ channels: { general: 'muted' }, stages: ['Tent'] })
    expect(store.getState().alertSettings).toEqual({
      channels: { general: 'muted' },
      stages: ['Tent'],
    })
    store.getState().setChannelAlerts('stage-2', 'all')
    store.getState().setChannelAlerts('general', 'mentions')
    store.getState().followStage('Main Stage', true)
    store.getState().followStage('Tent', false)
    expect(store.getState().alertSettings).toEqual({
      channels: { 'stage-2': 'all' },
      stages: ['Main Stage'],
    })
    expect(sent.filter((m) => m.type === 'setChannelAlerts' || m.type === 'followStage')).toEqual([
      { type: 'setChannelAlerts', channelId: 'stage-2', level: 'all' },
      { type: 'setChannelAlerts', channelId: 'general', level: 'mentions' },
      { type: 'followStage', stage: 'Main Stage', follow: true },
      { type: 'followStage', stage: 'Tent', follow: false },
    ])
    // The box's word, from any of the person's devices, is the last one.
    socket!.onMessage({ type: 'alertSettings', settings: { channels: {}, stages: [] } })
    expect(store.getState().alertSettings).toEqual({ channels: {}, stages: [] })
  })

  it('counts what came in while away by those settings', async () => {
    const store = await signedIn({ channels: { 'stage-2': 'all' }, stages: [] })
    socket!.onMessage(
      welcome([message('stage-2', 'hazer is out'), message('general', 'lunch is up')], {
        channels: { 'stage-2': 'all' },
        stages: [],
      })
    )
    await settle()
    expect(store.getState().alertBanner).toMatchObject({
      title: 'Alex in #stage-2',
      body: 'hazer is out',
    })
  })

  it('opens what a tapped alert names, in this event only', async () => {
    const store = await signedIn()
    const { receiveLink } = await import('./lib/appLinks.ts')
    receiveLink('crewbox://open?event=friday&to=showlog')
    expect(store.getState().activeModuleId).toBe('incident')
    receiveLink('crewbox://open?event=friday&channel=dm-alex')
    expect(store.getState().activeChannelId).toBe('dm-alex')
    receiveLink('crewbox://open?event=saturday&channel=stage-2')
    expect(store.getState().activeChannelId).toBe('dm-alex')
  })

  it("puts a followed stage's countdown on the app's lock screen, and takes it off when unfollowed", async () => {
    const calls: unknown[] = []
    let shown: string | null = null
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        CrewboxAlerts: {
          start: async () => {},
          stop: async () => {},
          setCountdown: async ({ stage }: { stage: string | null }) => {
            calls.push(stage)
            shown = stage
            return { stage }
          },
          getCountdown: async () => ({ stage: shown }),
        },
      },
    }
    try {
      const store = await signedIn({ channels: {}, stages: ['Main Stage'] })
      await settle()
      expect(store.getState().lockScreenStage).toBeNull()
      store.getState().setLockScreenStage('Main Stage')
      await settle()
      expect(store.getState().lockScreenStage).toBe('Main Stage')
      store.getState().followStage('Main Stage', false)
      await settle()
      expect(store.getState().lockScreenStage).toBeNull()
      expect(calls).toEqual(['Main Stage', null])
    } finally {
      delete window.Capacitor
    }
  })

  it('offers no lock screen outside the apps', async () => {
    const store = await signedIn()
    expect(store.getState().lockScreenStage).toBeUndefined()
  })
})
