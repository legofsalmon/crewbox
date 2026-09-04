// @vitest-environment happy-dom
//
// canSelectOutput reads navigator and HTMLMediaElement, which is the whole
// question it answers.
import { beforeEach, describe, expect, it } from 'vitest'
import { mixConflictsWithOutputPicker } from '../src/lib/voice-playback.ts'
import {
  canSelectOutput,
  isIOSFrom,
  resolveDevice,
  saveDeviceId,
  savedDeviceId,
} from '../src/lib/devices.ts'

// Minimal localStorage for the node test environment.
const backing = new Map<string, string>()
beforeEach(() => {
  backing.clear()
  globalThis.localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: () => null,
    length: 0,
  } as Storage
})

describe('device persistence', () => {
  it('round-trips and clears per kind', () => {
    expect(savedDeviceId('audioinput')).toBeNull()
    saveDeviceId('audioinput', 'mic-1')
    saveDeviceId('audiooutput', 'spk-9')
    expect(savedDeviceId('audioinput')).toBe('mic-1')
    expect(savedDeviceId('audiooutput')).toBe('spk-9')
    saveDeviceId('audioinput', null)
    expect(savedDeviceId('audioinput')).toBeNull()
    expect(savedDeviceId('audiooutput')).toBe('spk-9')
  })
})

describe('resolveDevice (headset unplugged mid-shift)', () => {
  const available = [
    { deviceId: 'mic-1', label: 'Headset' },
    { deviceId: 'mic-2', label: 'Built-in' },
  ]

  it('keeps the saved device while it exists', () => {
    expect(resolveDevice('mic-1', available)).toEqual({ deviceId: 'mic-1', fellBack: false })
  })

  it('falls back to default when the saved device vanishes', () => {
    expect(resolveDevice('mic-gone', available)).toEqual({ deviceId: null, fellBack: true })
  })

  it('uses default when nothing was saved', () => {
    expect(resolveDevice(null, available)).toEqual({ deviceId: null, fellBack: false })
  })
})

describe('canSelectOutput', () => {
  it('is false on iOS, where the system owns output routing', () => {
    // Was "false in node, which has no HTMLMediaElement" — true, but it was
    // testing the absence of a DOM rather than the rule. With a DOM present
    // the rule is what decides, so say which rule.
    const nav = globalThis.navigator as unknown as { userAgent: string }
    const original = Object.getOwnPropertyDescriptor(nav, 'userAgent')
    Object.defineProperty(nav, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605',
      configurable: true,
    })
    try {
      expect(canSelectOutput()).toBe(false)
    } finally {
      if (original) Object.defineProperty(nav, 'userAgent', original)
    }
  })
})

describe('isIOSFrom', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605'
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605'

  it('detects an iPhone by user-agent', () => {
    expect(isIOSFrom(IPHONE, 'iPhone', 5)).toBe(true)
  })

  it('detects iPadOS masquerading as a Mac (MacIntel + touch)', () => {
    expect(isIOSFrom(MAC, 'MacIntel', 5)).toBe(true)
  })

  it('is false for a real desktop Mac (no touch points)', () => {
    expect(isIOSFrom(MAC, 'MacIntel', 0)).toBe(false)
  })
})

describe('never offering a picker the mix would break', () => {
  const withUa = (ua: string, sinkId: boolean, fn: () => void) => {
    const nav = globalThis.navigator as unknown as { userAgent: string; platform: string }
    const originalUa = Object.getOwnPropertyDescriptor(nav, 'userAgent')
    Object.defineProperty(nav, 'userAgent', { value: ua, configurable: true })
    const had = 'setSinkId' in HTMLMediaElement.prototype
    if (sinkId && !had) {
      Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
        value: () => Promise.resolve(),
        configurable: true,
      })
    }
    try {
      fn()
    } finally {
      if (originalUa) Object.defineProperty(nav, 'userAgent', originalUa)
      if (sinkId && !had) delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId
    }
  }

  const SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
  const CHROME =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

  it('hides the speaker menu on desktop Safari, which mixes through Web Audio', () => {
    // The hole in the invariant voice-playback.ts calls unreachable: it is
    // unreachable on iOS because the picker is hidden there, and desktop
    // Safari both mixes *and*, since Safari 17, reports setSinkId on media
    // elements. Both were true, and the speaker menu threw when used.
    withUa(SAFARI, true, () => {
      expect(canSelectOutput()).toBe(false)
      expect(
        mixConflictsWithOutputPicker({
          ios: false,
          safari: true,
          canSelectOutput: canSelectOutput(),
        })
      ).toBe(false)
    })
  })

  it('still offers it where nothing is mixed', () => {
    withUa(CHROME, true, () => {
      expect(canSelectOutput()).toBe(true)
    })
  })
})
