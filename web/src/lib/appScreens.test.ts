// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_VERSION } from './pwa.ts'
import type { ScreensPlugin } from './server.ts'

/**
 * The page telling the apps its screens started (appScreens.ts). Each test
 * loads the module afresh, as a page load does, since a load says so once.
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
})

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
