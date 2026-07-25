/** Audio device preference persistence + fallback rules (unit-testable core). */

export type AudioKind = 'audioinput' | 'audiooutput'

export interface DeviceInfo {
  deviceId: string
  label: string
}

const KEYS: Record<AudioKind, string> = {
  audioinput: 'inter:audio-in',
  audiooutput: 'inter:audio-out',
}

export function savedDeviceId(kind: AudioKind): string | null {
  return localStorage.getItem(KEYS[kind])
}

export function saveDeviceId(kind: AudioKind, deviceId: string | null): void {
  if (deviceId === null) localStorage.removeItem(KEYS[kind])
  else localStorage.setItem(KEYS[kind], deviceId)
}

/**
 * Which device should actually be used: the saved choice if it still
 * exists, otherwise system default (null). Headsets get unplugged
 * mid-shift; silently vanishing audio is not acceptable at a festival.
 */
export function resolveDevice(saved: string | null, available: DeviceInfo[]): {
  deviceId: string | null
  fellBack: boolean
} {
  if (!saved) return { deviceId: null, fellBack: false }
  const found = available.some((d) => d.deviceId === saved)
  return found ? { deviceId: saved, fellBack: false } : { deviceId: null, fellBack: true }
}

/** Pure iOS check (testable): iPhone/iPad, incl. iPadOS masquerading as a Mac. */
export function isIOSFrom(ua: string, platform: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/.test(ua)) return true
  // iPadOS 13+ reports as "MacIntel" but is a touch device.
  return platform === 'MacIntel' && maxTouchPoints > 1
}

/** True on iPhone/iPad (incl. iPadOS masquerading as a Mac). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return isIOSFrom(navigator.userAgent, navigator.platform ?? '', navigator.maxTouchPoints ?? 0)
}

/**
 * Whether to offer an in-app speaker picker. Needs setSinkId, but even where
 * newer iOS Safari exposes it the only "devices" are Earpiece/Speaker, which
 * don't route the way users expect — iOS owns output routing (Control Centre,
 * AirPlay, Bluetooth auto-switch). So defer to the system there.
 */
export function canSelectOutput(): boolean {
  if (isIOS()) return false
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
}

/** Human label with a sensible fallback for permission-limited browsers. */
export function deviceLabel(device: MediaDeviceInfo, index: number): string {
  if (device.label) return device.label
  return device.kind === 'audioinput' ? `Microphone ${index + 1}` : `Speaker ${index + 1}`
}
