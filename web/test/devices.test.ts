import { beforeEach, describe, expect, it } from 'vitest'
import {
  canSelectOutput,
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
  it('is false without setSinkId support (node / iOS Safari)', () => {
    expect(canSelectOutput()).toBe(false)
  })
})
