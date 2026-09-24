// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playAlert, setSoundsEnabled } from './alerts.ts'

/**
 * The buzz that goes with an alert.
 *
 * `navigator.vibrate` never reached a phone from either app: the iPhone's web
 * view has no vibration API, and Android's is refused for an app without
 * VIBRATE. So in the apps the buzz is the platform's own haptic, and the web
 * API is left to the browsers that have one.
 *
 * There is no AudioContext here, so each alert's chirp fails the way it would
 * on a device with no audio, which is itself worth pinning: the buzz must
 * land anyway.
 */

const haptics = () => ({ notification: vi.fn(() => Promise.resolve()) })

function onScreen(visible: boolean): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visible ? 'visible' : 'hidden')
}

let vibrate: ReturnType<typeof vi.fn>

beforeEach(() => {
  setSoundsEnabled(true)
  onScreen(true)
  vibrate = vi.fn(() => true)
  Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete window.Capacitor
  Reflect.deleteProperty(navigator, 'vibrate')
  localStorage.clear()
})

describe('an alert in the apps', () => {
  it("buzzes with the platform's own haptic for something that needs you", () => {
    const plugin = haptics()
    window.Capacitor = { isNativePlatform: () => true, Plugins: { Haptics: plugin } }
    playAlert()
    expect(plugin.notification).toHaveBeenCalledWith({ type: 'WARNING' })
  })

  it('does not also ask the web view, which would refuse or double it', () => {
    window.Capacitor = { isNativePlatform: () => true, Plugins: { Haptics: haptics() } }
    playAlert()
    expect(vibrate).not.toHaveBeenCalled()
  })

  it('does not buzz once the app is out of sight', () => {
    // Android's alerts service posts the notification then, and it buzzes by
    // itself: one message, one buzz.
    const plugin = haptics()
    window.Capacitor = { isNativePlatform: () => true, Plugins: { Haptics: plugin } }
    onScreen(false)
    playAlert()
    expect(plugin.notification).not.toHaveBeenCalled()
  })

  it('shrugs off a haptic the phone refused', async () => {
    // A plain function, not `vi.fn`: a mock records how its promise settles,
    // which handles the rejection and would let this pass without a catch.
    const plugin = { notification: () => Promise.reject(new Error('no vibrator')) }
    window.Capacitor = { isNativePlatform: () => true, Plugins: { Haptics: plugin } }
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      expect(() => playAlert()).not.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('an alert in a browser', () => {
  it('buzzes through the web API, in the same pattern as before', () => {
    playAlert()
    expect(vibrate).toHaveBeenCalledWith([120, 60, 120])
  })

  it('does not buzz in a background tab', () => {
    onScreen(false)
    playAlert()
    expect(vibrate).not.toHaveBeenCalled()
  })

  it('is fine in a browser with no vibration at all', () => {
    Reflect.deleteProperty(navigator, 'vibrate')
    expect(() => playAlert()).not.toThrow()
  })
})

describe('muted alerts', () => {
  it('neither chirp nor buzz', () => {
    const plugin = haptics()
    window.Capacitor = { isNativePlatform: () => true, Plugins: { Haptics: plugin } }
    setSoundsEnabled(false)
    playAlert()
    expect(plugin.notification).not.toHaveBeenCalled()
    expect(vibrate).not.toHaveBeenCalled()
  })
})
