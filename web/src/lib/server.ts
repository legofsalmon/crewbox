/**
 * Where is the crew server? For the PWA the answer is always "same origin"
 * (the server serves the bundle). Native wrappers load the bundle from the
 * app package instead, so they carry a configured server origin — stored in
 * localStorage and applied to every API/WS/file URL.
 */
import type { FileMeta } from '@crewbox/shared'
import { fileUrl } from '@crewbox/shared'

const SERVER_KEY = 'crewbox:server-url'

interface AlertsPlugin {
  start(options: { serverUrl: string; token: string; myName: string }): Promise<void>
  stop(): Promise<void>
}

/**
 * Capacitor's App plugin, as the native side puts it on the page. The web app
 * does not bundle @capacitor/core, so this is the raw bridge: `addListener`
 * returns a handle rather than a promise. Only Android fires `backButton`.
 */
interface AppPlugin {
  addListener(event: 'backButton', listener: (event: { canGoBack: boolean }) => void): unknown
  minimizeApp(): Promise<void>
}

/** Android's side of voice (native/android VoicePlugin). */
interface VoicePlugin {
  /** Before a join opens any audio: asks about Bluetooth once, when it matters. */
  prepare(): Promise<void>
}

/** Capacitor's Haptics plugin: the platform's own vibration, in both apps. */
interface HapticsPlugin {
  notification(options: { type: 'SUCCESS' | 'WARNING' | 'ERROR' }): Promise<void>
}

/**
 * Capacitor's SystemBars plugin, built into Capacitor 8 on both platforms.
 * The style names the bar, not its text: `DARK` gets light text.
 */
interface SystemBarsPlugin {
  setStyle(options: { style: 'DARK' | 'LIGHT' | 'DEFAULT' }): Promise<void>
}

declare global {
  interface Window {
    Capacitor?: {
      isNativePlatform?: () => boolean
      getPlatform?: () => string
      Plugins?: {
        CrewboxAlerts?: AlertsPlugin
        App?: AppPlugin
        CrewboxVoice?: VoicePlugin
        Haptics?: HapticsPlugin
        SystemBars?: SystemBarsPlugin
      }
    }
  }
}

/** True when running inside a Capacitor native shell. */
export function isNative(): boolean {
  return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.()
}

/** True inside the Android app, as opposed to the iPhone app or any browser. */
export function isAndroidApp(): boolean {
  return isNative() && window.Capacitor?.getPlatform?.() === 'android'
}

/** True inside the iPhone app, as opposed to the Android app or any browser. */
export function isIosApp(): boolean {
  return isNative() && window.Capacitor?.getPlatform?.() === 'ios'
}

/** The Android background-alerts bridge, when present (native builds only). */
export function nativeAlerts(): AlertsPlugin | undefined {
  return window.Capacitor?.Plugins?.CrewboxAlerts
}

/** Capacitor's App plugin: the back button and the app's lifecycle (native only). */
export function nativeApp(): AppPlugin | undefined {
  return window.Capacitor?.Plugins?.App
}

/** The Android voice bridge, when present (Android builds only). */
export function nativeVoice(): VoicePlugin | undefined {
  return window.Capacitor?.Plugins?.CrewboxVoice
}

/** Capacitor's Haptics plugin (native only). */
export function nativeHaptics(): HapticsPlugin | undefined {
  return window.Capacitor?.Plugins?.Haptics
}

/** Capacitor's SystemBars plugin: the colour of the status bar's text (native only). */
export function nativeSystemBars(): SystemBarsPlugin | undefined {
  return window.Capacitor?.Plugins?.SystemBars
}

/**
 * Normalize user input into an origin: adds http:// when no scheme is given
 * (native LAN use — the whole point is not needing certificates), strips
 * paths and trailing slashes. Returns '' for empty/invalid input.
 */
export function normalizeOrigin(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    return new URL(withScheme).origin
  } catch {
    return ''
  }
}

/** The configured server origin, or '' meaning same-origin (PWA default). */
export function serverOrigin(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setServerOrigin(input: string): void {
  const origin = normalizeOrigin(input)
  if (origin) localStorage.setItem(SERVER_KEY, origin)
  else localStorage.removeItem(SERVER_KEY)
}

/** Prefix a server-relative path (e.g. `/api/join`) with the configured origin. */
export function apiUrl(path: string): string {
  return serverOrigin() + path
}

/** The WebSocket endpoint, honouring the configured origin's scheme. */
export function wsUrl(): string {
  const origin = serverOrigin()
  if (origin) return origin.replace(/^http/i, 'ws') + '/ws'
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}

/** The shared-docs WebSocket base; providers append /<module>/<room>. */
export function docsWsUrl(): string {
  return wsUrl() + '/docs'
}

/** Absolute URL for a shared file — shareable/copyable off-device. */
export function absoluteFileUrl(file: FileMeta): string {
  return (serverOrigin() || location.origin) + fileUrl(file)
}

/** Human label for where the app is trying to connect (diagnostics copy). */
export function serverLabel(): string {
  const origin = serverOrigin()
  return origin ? origin.replace(/^https?:\/\//i, '') : location.host
}
