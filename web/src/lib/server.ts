/**
 * Where is the crew server? For the PWA the answer is always "same origin"
 * (the server serves the bundle). Native wrappers load the bundle from the
 * app package instead, so they carry a configured server origin — stored in
 * localStorage and applied to every API/WS/file URL.
 */
import type { FileMeta } from '@inter/shared'
import { fileUrl } from '@inter/shared'

const SERVER_KEY = 'inter:server-url'

interface AlertsPlugin {
  start(options: { serverUrl: string; token: string; myName: string }): Promise<void>
  stop(): Promise<void>
}

declare global {
  interface Window {
    Capacitor?: {
      isNativePlatform?: () => boolean
      Plugins?: { InterAlerts?: AlertsPlugin }
    }
  }
}

/** True when running inside a Capacitor native shell. */
export function isNative(): boolean {
  return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.()
}

/** The Android background-alerts bridge, when present (native builds only). */
export function nativeAlerts(): AlertsPlugin | undefined {
  return window.Capacitor?.Plugins?.InterAlerts
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

/** Absolute URL for a shared file — shareable/copyable off-device. */
export function absoluteFileUrl(file: FileMeta): string {
  return (serverOrigin() || location.origin) + fileUrl(file)
}

/** Human label for where the app is trying to connect (diagnostics copy). */
export function serverLabel(): string {
  const origin = serverOrigin()
  return origin ? origin.replace(/^https?:\/\//i, '') : location.host
}
