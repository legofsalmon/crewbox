// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { forgetPref, readPref, writePref } from '../src/lib/prefs.ts'
import { savedDeviceId, saveDeviceId } from '../src/lib/devices.ts'
import { soundsEnabled, setSoundsEnabled } from '../src/lib/alerts.ts'

/**
 * A browser that will not let this app have localStorage.
 *
 * It does not answer null — it throws, and in two different places. Chrome
 * and Firefox with site data blocked throw on the *property access*, before
 * any method is called; Safari's private mode used to throw on `setItem`
 * once its tiny quota ran out. Both are simulated below, because a guard
 * that only wraps the method call is no guard at all in the first case.
 *
 * The reads that matter happen at the worst moment: `initialConfig()` runs
 * while the store module is being evaluated and `IosInstallTip` reads during
 * its first render, so the exception is not a lost preference — it is a
 * blank screen on a phone in a field, with nothing on it to explain itself.
 * The same lesson as `db.ts`: this is a cache of somebody's preferences, and
 * having none of it costs a theme and a tip shown twice.
 */

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

const boom = (): never => {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}

/** Site data blocked: touching `localStorage` at all throws. */
const blockAccess = (): void => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: boom })
}

/** Storage that answers, until it is asked to keep something. */
const blockWrites = (): void => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: boom, removeItem: boom },
  })
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original)
  localStorage.clear()
})

describe('preferences when the store refuses', () => {
  it('reads as absent rather than throwing, even on the access itself', () => {
    blockAccess()
    expect(() => readPref('crewbox:theme')).not.toThrow()
    expect(readPref('crewbox:theme')).toBeNull()
  })

  it('writes and forgets without throwing', () => {
    blockWrites()
    expect(() => writePref('crewbox:theme', 'light')).not.toThrow()
    expect(() => forgetPref('crewbox:theme')).not.toThrow()
  })

  it('still remembers things when the browser is willing', () => {
    // The guard must not have quietly turned every preference off.
    writePref('crewbox:theme', 'light')
    expect(readPref('crewbox:theme')).toBe('light')
    forgetPref('crewbox:theme')
    expect(readPref('crewbox:theme')).toBeNull()
  })

  it('leaves a call joinable with no saved device', () => {
    // Called on the way into every voice join.
    blockAccess()
    expect(savedDeviceId('audioinput')).toBeNull()
    expect(() => saveDeviceId('audioinput', 'headset-1')).not.toThrow()
  })

  it('keeps alert sounds on, which is the safe default', () => {
    // Called as a message arrives, from the handler that draws it — so a
    // throw here would mean the message never appears at all.
    blockAccess()
    expect(soundsEnabled()).toBe(true)
    expect(() => setSoundsEnabled(false)).not.toThrow()
  })
})
