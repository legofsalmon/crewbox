// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@crewbox/shared'
import { APP_VERSION } from './pwa.ts'
import type { ScreensAnswer, ScreensPlugin } from './server.ts'

/**
 * The page's side of the screens the apps run (appScreens.ts): telling the
 * app its screens started, offering the box's own, and having the app serve
 * the right ones before the page reloads into another event. Each test loads
 * the module afresh, as a page load does, since a load says so once and asks
 * once.
 */

async function load(): Promise<typeof import('./appScreens.ts')> {
  vi.resetModules()
  return import('./appScreens.ts')
}

/** The app's side, with its screens plugin as a test gives it. */
function appWith(screens: Partial<ScreensPlugin>) {
  ;(window as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: { CrewboxScreens: screens },
  }
}

/** The app's side, answering every call. */
function app() {
  const plugin = {
    prepare: vi.fn<ScreensPlugin['prepare']>(),
    use: vi.fn<ScreensPlugin['use']>(),
    ready: vi.fn<ScreensPlugin['ready']>(async () => {}),
  }
  appWith(plugin)
  return plugin
}

afterEach(() => {
  delete (window as { Capacitor?: unknown }).Capacitor
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Let a promise chain run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A build of crewbox these screens aren't, as a box's welcome names it. */
const OTHER = '9.8.7+abc1234'

/** The same build as these screens, another version, or another protocol. */
const SAME = { serverVersion: APP_VERSION, protocolVersion: PROTOCOL_VERSION }
const NEWER = { serverVersion: OTHER, protocolVersion: PROTOCOL_VERSION }
const NEWER_PROTOCOL = { serverVersion: OTHER, protocolVersion: PROTOCOL_VERSION + 1 }
const OLDER_PROTOCOL = { serverVersion: OTHER, protocolVersion: PROTOCOL_VERSION - 1 }

describe('screensStarted', () => {
  it('tells the app which screens started, once a load', async () => {
    const plugin = app()
    const screens = await load()
    screens.screensStarted()
    screens.screensStarted()
    expect(plugin.ready).toHaveBeenCalledTimes(1)
    expect(plugin.ready).toHaveBeenCalledWith({ version: APP_VERSION })
    expect(plugin.use).not.toHaveBeenCalled()
  })

  it('tells it again after the page loads again', async () => {
    const plugin = app()
    ;(await load()).screensStarted()
    ;(await load()).screensStarted()
    expect(plugin.ready).toHaveBeenCalledTimes(2)
  })

  it('takes a refusal as nothing to do', async () => {
    // Not a vi.fn, which would handle the rejection it returns itself.
    let asked = 0
    appWith({
      ready: async () => {
        asked++
        throw new Error('The app is closing')
      },
    })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      ;(await load()).screensStarted()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(asked).toBe(1)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('says nothing in a browser', async () => {
    const plugin = app()
    ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor!.isNativePlatform =
      () => false
    ;(await load()).screensStarted()
    expect(plugin.ready).not.toHaveBeenCalled()
  })

  it('does without in an app that keeps no screens', async () => {
    ;(window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {},
    }
    await expect(load().then((screens) => screens.screensStarted())).resolves.toBeUndefined()
  })
})

describe('otherBuild', () => {
  it('is another version where both sides know which build they are, or another protocol', async () => {
    const { otherBuild } = await load()
    expect(otherBuild(SAME)).toBe(false)
    expect(otherBuild(NEWER)).toBe(true)
    expect(otherBuild({ serverVersion: OTHER })).toBe(true)
    // A tree with no git gives a `+unknown` build, which says nothing (pwa.ts).
    expect(otherBuild({ serverVersion: '9.8.7+unknown' })).toBe(false)
    expect(otherBuild({ serverVersion: APP_VERSION, protocolVersion: PROTOCOL_VERSION + 1 })).toBe(
      true
    )
    expect(otherBuild({ serverVersion: '9.8.7+unknown', protocolVersion: 0 })).toBe(true)
    // Older servers leave the protocol out.
    expect(otherBuild({ serverVersion: APP_VERSION })).toBe(false)
    expect(otherBuild({})).toBe(false)
  })
})

describe('offerFrom', () => {
  const answer = (result: ScreensAnswer['result'], more: Partial<ScreensAnswer> = {}) => ({
    result,
    ...more,
  })

  it('offers the box’s screens whenever the app has them and they aren’t these', async () => {
    const { offerFrom } = await load()
    expect(offerFrom(answer('ready', { version: OTHER }), NEWER)).toEqual({
      kind: 'switch',
      version: OTHER,
    })
    // The app's own, when these are ones it fetched.
    expect(offerFrom(answer('same', { version: OTHER }), NEWER_PROTOCOL)).toEqual({
      kind: 'switch',
      version: OTHER,
    })
  })

  it('never offers a reload that would change nothing', async () => {
    const { offerFrom } = await load()
    expect(offerFrom(answer('ready', { version: APP_VERSION }), NEWER)).toBeNull()
    expect(offerFrom(answer('same', { version: APP_VERSION }), NEWER)).toBeNull()
    expect(offerFrom(answer('ready'), NEWER)).toBeNull()
  })

  it('says which to update when the box’s screens need a newer app', async () => {
    const { offerFrom } = await load()
    const needsApp = answer('incompatible', { version: OTHER, update: 'app' })
    expect(offerFrom(needsApp, NEWER)).toEqual({
      kind: 'note',
      text: 'This box runs crewbox 9.8.7, whose screens need a newer app. Update the app to use them.',
    })
    expect(offerFrom(needsApp, NEWER_PROTOCOL)).toEqual({
      kind: 'note',
      text: 'This box runs crewbox 9.8.7, newer than this app can use. Update the app.',
    })
  })

  it('says nothing of a box too old for the app while the two speak one protocol', async () => {
    const { offerFrom } = await load()
    const tooOld = answer('incompatible', { version: OTHER, update: 'box' })
    expect(offerFrom(tooOld, NEWER)).toBeNull()
    expect(offerFrom(tooOld, OLDER_PROTOCOL)).toEqual({
      kind: 'note',
      text: 'This box runs crewbox 9.8.7, older than this app can use. Update the box.',
    })
  })

  it('says nothing when the app keeps these screens and they speak the box’s protocol', async () => {
    const { offerFrom } = await load()
    expect(offerFrom(answer('unsigned', { reason: 'no signed screens' }), NEWER)).toBeNull()
    expect(offerFrom(answer('failed', { reason: 'no signal' }), NEWER)).toBeNull()
  })

  it('says which side to update, and why the app can’t run the box’s screens, across protocols', async () => {
    const { offerFrom } = await load()
    expect(offerFrom(answer('unsigned'), NEWER_PROTOCOL)).toEqual({
      kind: 'note',
      text:
        'This box runs crewbox 9.8.7, newer than this app can use, and has no screens from a ' +
        'crewbox release for the app to run instead. Update the app.',
    })
    expect(offerFrom(answer('failed'), OLDER_PROTOCOL)).toEqual({
      kind: 'note',
      text:
        'This box runs crewbox 9.8.7, older than this app can use, and the app couldn’t get ' +
        'its screens to run instead. Update the box.',
    })
  })
})

describe('screensAfterWelcome', () => {
  const ORIGIN = 'http://192.168.1.20:8080'

  it('asks nothing of a box running these screens’ build, and says so at once', async () => {
    const plugin = app()
    const { screensAfterWelcome } = await load()
    const show = vi.fn()
    screensAfterWelcome(ORIGIN, SAME, show)
    expect(show).toHaveBeenCalledWith(null)
    expect(plugin.prepare).not.toHaveBeenCalled()
  })

  it('asks the app for the screens of a box running another build, and offers what it answers', async () => {
    const plugin = app()
    plugin.prepare.mockResolvedValue({ result: 'ready', version: OTHER })
    const { screensAfterWelcome } = await load()
    const show = vi.fn()
    screensAfterWelcome(ORIGIN, NEWER, show)
    // Nothing while the app fetches.
    expect(show).not.toHaveBeenCalled()
    await settle()
    expect(plugin.prepare).toHaveBeenCalledWith({ origin: ORIGIN })
    expect(show).toHaveBeenCalledWith({ kind: 'switch', version: OTHER })
  })

  it('asks once a load for each build, and again after a failure', async () => {
    const plugin = app()
    plugin.prepare.mockResolvedValue({ result: 'ready', version: OTHER })
    const screens = await load()
    const show = vi.fn()
    screens.screensAfterWelcome(ORIGIN, NEWER, show)
    screens.screensAfterWelcome(ORIGIN, NEWER, show)
    await settle()
    expect(plugin.prepare).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(1)
    screens.screensAfterWelcome(ORIGIN, NEWER, show)
    await settle()
    expect(plugin.prepare).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(2)

    // Another build, or another box, is another question.
    screens.screensAfterWelcome(ORIGIN, NEWER_PROTOCOL, show)
    screens.screensAfterWelcome('http://192.168.1.21:8080', NEWER, show)
    await settle()
    expect(plugin.prepare).toHaveBeenCalledTimes(3)

    plugin.prepare.mockClear()
    plugin.prepare.mockResolvedValue({ result: 'failed', reason: 'no signal' })
    const fresh = await load()
    fresh.screensAfterWelcome(ORIGIN, NEWER, show)
    await settle()
    fresh.screensAfterWelcome(ORIGIN, NEWER, show)
    await settle()
    expect(plugin.prepare).toHaveBeenCalledTimes(2)
  })

  it('offers nothing from a welcome another has come after', async () => {
    const plugin = app()
    let answer: (value: ScreensAnswer) => void = () => {}
    plugin.prepare.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { screensAfterWelcome } = await load()
    const show = vi.fn()
    screensAfterWelcome(ORIGIN, NEWER, show)
    // The box is back on these screens' build before the app has answered.
    screensAfterWelcome(ORIGIN, SAME, show)
    answer({ result: 'ready', version: OTHER })
    await settle()
    expect(show.mock.calls).toEqual([[null]])
  })

  it('takes a refusal, or an app that keeps no screens, as a failure', async () => {
    appWith({ prepare: () => Promise.reject(new Error('A box’s address is needed')) })
    const show = vi.fn()
    ;(await load()).screensAfterWelcome(ORIGIN, NEWER_PROTOCOL, show)
    await settle()
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'note' }))
    expect(show.mock.calls[0]![0].text).toContain('the app couldn’t get its screens')

    ;(window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {},
    }
    const quiet = vi.fn()
    ;(await load()).screensAfterWelcome(ORIGIN, NEWER, quiet)
    await settle()
    // Never a pill that can only reload the screens running.
    expect(quiet).toHaveBeenCalledWith(null)
  })
})

describe('screensForEvent', () => {
  const ORIGIN = 'http://192.168.1.30:8080'

  /** The box at ORIGIN answering /api/config as `event`, or not at all. */
  function boxAnswers(event: string | null) {
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        asked.push(String(input))
        if (event === null) throw new TypeError('Failed to fetch')
        return new Response(JSON.stringify({ eventName: 'Harbour Tour', eventId: event }), {
          headers: { 'content-type': 'application/json' },
        })
      })
    )
    return asked
  }

  it('has the app serve the event’s box’s screens when it has them', async () => {
    const plugin = app()
    const asked = boxAnswers('saturday')
    plugin.prepare.mockResolvedValue({ result: 'ready', version: OTHER })
    plugin.use.mockResolvedValue(undefined)
    await (await load()).screensForEvent('saturday', ORIGIN)
    expect(asked).toEqual([`${ORIGIN}/api/config`])
    expect(plugin.prepare).toHaveBeenCalledWith({ origin: ORIGIN })
    expect(plugin.use.mock.calls).toEqual([[{ event: 'saturday', version: OTHER }]])
  })

  it('takes the app’s own screens by name when the box runs them', async () => {
    const plugin = app()
    boxAnswers('saturday')
    plugin.prepare.mockResolvedValue({ result: 'same', version: APP_VERSION })
    plugin.use.mockResolvedValue(undefined)
    await (await load()).screensForEvent('saturday', ORIGIN)
    expect(plugin.use.mock.calls).toEqual([[{ event: 'saturday', version: APP_VERSION }]])
  })

  it('runs what the event would start with when its box can’t say what it runs', async () => {
    for (const [event, answer] of [
      [null, undefined],
      ['sunday', undefined],
      ['saturday', { result: 'unsigned' as const }],
      ['saturday', { result: 'incompatible' as const, version: OTHER, update: 'app' as const }],
      ['saturday', { result: 'failed' as const }],
    ] as const) {
      const plugin = app()
      boxAnswers(event)
      if (answer) plugin.prepare.mockResolvedValue(answer)
      plugin.use.mockResolvedValue(undefined)
      await (await load()).screensForEvent('saturday', ORIGIN)
      expect(plugin.use.mock.calls, `${event} ${answer?.result}`).toEqual([[{ event: 'saturday' }]])
      // Nothing fetched from a box running another event, or none at all.
      expect(plugin.prepare).toHaveBeenCalledTimes(answer ? 1 : 0)
    }
  })

  it('asks no box at all for an event with no address, and still has the app choose', async () => {
    const plugin = app()
    const asked = boxAnswers('saturday')
    plugin.use.mockResolvedValue(undefined)
    await (await load()).screensForEvent('saturday', undefined)
    expect(asked).toEqual([])
    expect(plugin.use.mock.calls).toEqual([[{ event: 'saturday' }]])
  })

  it('falls back to what the event would start with when the app won’t run the screens after all', async () => {
    const plugin = app()
    boxAnswers('saturday')
    plugin.prepare.mockResolvedValue({ result: 'ready', version: OTHER })
    plugin.use.mockImplementation(async ({ version }) => {
      if (version) throw new Error(`${version} didn't start on this phone`)
    })
    await (await load()).screensForEvent('saturday', ORIGIN)
    expect(plugin.use.mock.calls).toEqual([
      [{ event: 'saturday', version: OTHER }],
      [{ event: 'saturday' }],
    ])
  })

  it('never rejects', async () => {
    const plugin = app()
    boxAnswers(null)
    plugin.use.mockRejectedValue(new Error('The app is closing'))
    await expect((await load()).screensForEvent('saturday', ORIGIN)).resolves.toBeUndefined()
  })

  it('asks the box for no longer than a few seconds', async () => {
    const plugin = app()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    boxAnswers('saturday')
    plugin.prepare.mockResolvedValue({ result: 'ready', version: OTHER })
    plugin.use.mockResolvedValue(undefined)
    const screens = await load()
    await screens.screensForEvent('saturday', ORIGIN)
    expect(timeout).toHaveBeenCalledWith(screens.BOX_WAIT_MS)
    expect(screens.BOX_WAIT_MS).toBe(3000)
  })

  it('asks the app for nothing more while it is still fetching after a while', async () => {
    // A switch asked for then would wait behind the fetch, and could land
    // after the reload, under screens it wasn't meant for.
    const plugin = app()
    boxAnswers('saturday')
    plugin.prepare.mockReturnValue(new Promise(() => {}))
    const screens = await load()
    vi.useFakeTimers()
    let settled = false
    void screens.screensForEvent('saturday', ORIGIN).then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(screens.SCREENS_WAIT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(plugin.use).not.toHaveBeenCalled()
    expect(screens.SCREENS_WAIT_MS).toBe(10_000)
  })

  it('does nothing in a browser, or in an app that keeps no screens', async () => {
    const plugin = app()
    const asked = boxAnswers('saturday')
    ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor!.isNativePlatform =
      () => false
    await (await load()).screensForEvent('saturday', ORIGIN)
    ;(window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {},
    }
    await (await load()).screensForEvent('saturday', ORIGIN)
    expect(asked).toEqual([])
    expect(plugin.use).not.toHaveBeenCalled()
  })
})

describe('switchScreens', () => {
  it('has the app serve the screens for the event, and rejects when it won’t', async () => {
    const plugin = app()
    plugin.use.mockResolvedValueOnce(undefined)
    const screens = await load()
    await screens.switchScreens('friday', OTHER)
    expect(plugin.use).toHaveBeenCalledWith({ event: 'friday', version: OTHER })
    plugin.use.mockRejectedValueOnce(new Error('gone'))
    await expect(screens.switchScreens('friday', OTHER)).rejects.toThrow('gone')
  })
})
