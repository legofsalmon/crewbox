// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, useStore } from './store.ts'

/**
 * The iPhone app's status bar, in the page's theme.
 *
 * The page runs under the bar, and iOS colours the clock and battery from the
 * phone's appearance unless the app says otherwise, so a phone in dark mode
 * showing the light theme had white text on cream. The app now says: light
 * text on the navy page, dark text on the cream one.
 */

interface Bars {
  setStyle(options: { style: 'DARK' | 'LIGHT' | 'DEFAULT' }): Promise<void>
}

const systemBars = (): Bars => ({ setStyle: vi.fn(() => Promise.resolve()) })

function inApp(platform: 'ios' | 'android', plugin: Bars = systemBars()): Bars {
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: { SystemBars: plugin },
  }
  return plugin
}

afterEach(() => {
  delete window.Capacitor
  localStorage.clear()
})

describe('in the iPhone app', () => {
  it('the dark theme gets light status text', () => {
    // The plugin names the bar, not its text: DARK is a dark bar.
    const bars = inApp('ios')
    applyTheme('dark')
    expect(bars.setStyle).toHaveBeenLastCalledWith({ style: 'DARK' })
  })

  it('the light theme gets dark status text', () => {
    const bars = inApp('ios')
    applyTheme('light')
    expect(bars.setStyle).toHaveBeenLastCalledWith({ style: 'LIGHT' })
  })

  it('the bar follows the theme button', () => {
    const bars = inApp('ios')
    const first = useStore.getState().theme
    const other = first === 'dark' ? 'light' : 'dark'
    const style = (theme: string) => (theme === 'dark' ? 'DARK' : 'LIGHT')

    useStore.getState().toggleTheme()
    expect(bars.setStyle).toHaveBeenLastCalledWith({ style: style(other) })
    useStore.getState().toggleTheme()
    expect(bars.setStyle).toHaveBeenLastCalledWith({ style: style(first) })
  })

  it('shrugs off a bar that refuses', async () => {
    // A plain function, not `vi.fn`: a mock records how its promise settles,
    // which handles the rejection and would let this pass without a catch.
    inApp('ios', { setStyle: () => Promise.reject(new Error('no bar')) })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      expect(() => applyTheme('light')).not.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('still themes the page in a shell without the plugin', () => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

describe('outside the iPhone app', () => {
  it("leaves the Android app's bar to the system", () => {
    // Below Android 15 that bar is a solid system colour, which the page's
    // theme says nothing about.
    const bars = inApp('android')
    applyTheme('light')
    applyTheme('dark')
    expect(bars.setStyle).not.toHaveBeenCalled()
  })

  it('has nothing to set in a browser', () => {
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
