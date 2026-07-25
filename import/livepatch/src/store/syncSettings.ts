export interface SyncSettings {
  /** ws:// or wss:// URL of the relay, e.g. wss://sync.example.com or ws://192.168.1.20:1234 */
  url: string
  token: string
}

const KEY = 'livepatch-sync'

declare global {
  interface Window {
    /** Injected by the relay when it serves the app ("festival box" mode). */
    __LIVEPATCH_BOX__?: boolean
  }
}

/** When the relay itself served this page, it is also the sync server. */
const boxDefaultUrl = (): string =>
  typeof window !== 'undefined' && window.__LIVEPATCH_BOX__
    ? window.location.origin.replace(/^http/i, 'ws')
    : ''

const envDefault = (): SyncSettings => ({
  url: (import.meta.env.VITE_SYNC_URL as string | undefined) ?? boxDefaultUrl(),
  token: (import.meta.env.VITE_SYNC_TOKEN as string | undefined) ?? '',
})

export const loadSyncSettings = (): SyncSettings => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return envDefault()
    const parsed = JSON.parse(raw) as Partial<SyncSettings>
    return {
      // On a box, an unset URL heals to the box itself — crew devices should
      // never sit silently unsynced; an explicit different URL is respected.
      url: parsed.url || boxDefaultUrl(),
      token: parsed.token ?? '',
    }
  } catch {
    return envDefault()
  }
}

export const saveSyncSettings = (settings: SyncSettings) => {
  localStorage.setItem(KEY, JSON.stringify(settings))
}

/** Accepts http(s) URLs too and converts them to ws(s). */
export const normalizeSyncUrl = (input: string): string => {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/^wss?:\/\//i.test(trimmed)) return trimmed
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^http/i, 'ws')
  return `ws://${trimmed}`
}
