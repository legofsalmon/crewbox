import type { Channel, FileMeta, Message, PublicConfig, User } from '@crewbox/shared'
import { apiUrl } from './server.ts'

export type ReadinessState = 'ok' | 'limited' | 'off'
/** Environment checks add `info`: worth knowing, nothing to fix. */
export type EnvState = ReadinessState | 'info'

export interface ReadinessCheck {
  id: string
  label: string
  state: ReadinessState
  detail: string
  fix?: string
}

/**
 * What an admin request needs: the crew session, plus proof that someone
 * typed the admin password. Passed as one object so a new admin call can't
 * quietly forget the second half — the panel is locked by default and every
 * route behind it checks both.
 */
export interface AdminAuth {
  token: string
  adminToken: string
}

const adminHeaders = (auth: AdminAuth): Record<string, string> => ({
  authorization: `Bearer ${auth.token}`,
  'x-admin-token': auth.adminToken,
})

export interface AdminSettings {
  settings: { eventName: string; wifiSsid: string }
  serverInfo: {
    version: string
    uptimeSec: number
    connections: number
    onlineUsers: number
    voiceEnabled: boolean
    eventPin: string
    /** True when ADMIN_PASSWORD is set, so the panel can't change it here. */
    adminPasswordFromEnv: boolean
  }
  /** What this box can actually do right now — see server/src/readiness.ts. */
  readiness: ReadinessCheck[]
  readinessState: ReadinessState
  /**
   * The lighting network, if this box was asked to listen to one. Its own
   * list rather than folded into `readiness`: a rig can be fine while the box
   * is not, and the other way round. Optional so an older box still parses.
   */
  lighting?: ReadinessCheck[]
}

export interface EnvCheck {
  id: string
  label: string
  state: EnvState
  detail: string
  fix?: string
}

/** What the box has been plugged into — see server/src/environment.ts. */
export interface EnvironmentReport {
  checks: EnvCheck[]
  probedAt: number
  /** True before the first sweep finishes; the panel shows "checking". */
  pending?: boolean
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // apiUrl prefixes the configured server origin (native builds); '' for the PWA.
  const res = await fetch(apiUrl(path), init)
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T
  if (!res.ok) throw new ApiError(data.error ?? `request failed (${res.status})`, res.status)
  return data
}

export function join(input: {
  name: string
  eventPin: string
  personalPin: string
}): Promise<{ token: string; user: User; created: boolean }> {
  return request('/api/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function uploadFile(
  token: string,
  file: File,
  image?: { width: number; height: number; thumb: Blob | null }
): Promise<{ file: FileMeta }> {
  const form = new FormData()
  // Fields and thumb go before the file so the server sees them first.
  if (image) {
    form.append('width', String(image.width))
    form.append('height', String(image.height))
    if (image.thumb) form.append('thumb', image.thumb, 'thumb')
  }
  form.append('file', file)
  return request('/api/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
}

export function voiceToken(
  token: string,
  channelId: string
): Promise<{ url: string; token: string }> {
  return request('/api/voice/token', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channelId }),
  })
}

export function search(token: string, q: string): Promise<{ messages: Message[] }> {
  return request(`/api/search?${new URLSearchParams({ q })}`, {
    headers: { authorization: `Bearer ${token}` },
  })
}

export function fetchContext(
  token: string,
  channelId: string,
  seq: number
): Promise<{ messages: Message[] }> {
  const params = new URLSearchParams({ seq: String(seq) })
  return request(`/api/channels/${channelId}/context?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  })
}

export function fetchHistory(
  token: string,
  channelId: string,
  beforeSeq: number,
  limit = 100
): Promise<{ messages: Message[] }> {
  const params = new URLSearchParams({ beforeSeq: String(beforeSeq), limit: String(limit) })
  return request(`/api/channels/${channelId}/messages?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  })
}

/** Trade the admin password for a token. Held in memory only — see the store. */
export function adminUnlock(token: string, password: string): Promise<{ adminToken: string }> {
  return request('/api/admin/unlock', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
}

/** Hand the unlock back rather than waiting for it to expire. */
export function adminLock(auth: AdminAuth): Promise<{ ok: true }> {
  return request('/api/admin/lock', { method: 'POST', headers: adminHeaders(auth) })
}

export function adminResetPin(auth: AdminAuth, userId: string, pin: string): Promise<{ ok: true }> {
  return request(`/api/admin/users/${userId}/pin`, {
    method: 'POST',
    headers: { ...adminHeaders(auth), 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
}

export function adminUpdateChannel(
  auth: AdminAuth,
  channelId: string,
  patch: { name?: string; topic?: string; retired?: boolean }
): Promise<{ channel: Channel }> {
  return request(`/api/admin/channels/${channelId}`, {
    method: 'PATCH',
    headers: { ...adminHeaders(auth), 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export function getConfig(): Promise<PublicConfig> {
  return request('/api/config')
}

/**
 * Delete a shared file. The author needs no admin token; anyone else does,
 * which is why it's optional here rather than an AdminAuth.
 */
export function deleteMessage(
  token: string,
  messageId: string,
  adminToken?: string
): Promise<{ ok: true }> {
  return request(`/api/messages/${messageId}`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${token}`,
      ...(adminToken ? { 'x-admin-token': adminToken } : {}),
    },
  })
}

/** Permanently delete the signed-in user's own account. */
export function deleteAccount(token: string): Promise<{ ok: true }> {
  return request('/api/me', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
}

export function adminGetEnvironment(auth: AdminAuth, refresh = false): Promise<EnvironmentReport> {
  return request(`/api/admin/environment${refresh ? '?refresh=1' : ''}`, {
    headers: adminHeaders(auth),
  })
}

/** The local DNS config for this box, as a file to put on the venue router. */
export async function adminDnsConfig(auth: AdminAuth): Promise<Blob> {
  const res = await fetch(apiUrl('/api/admin/dns-config'), { headers: adminHeaders(auth) })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(data.error ?? `request failed (${res.status})`, res.status)
  }
  return res.blob()
}

export function adminGetSettings(auth: AdminAuth): Promise<AdminSettings> {
  return request('/api/admin/settings', { headers: adminHeaders(auth) })
}

export function adminUpdateSettings(
  auth: AdminAuth,
  patch: { eventName?: string; wifiSsid?: string; eventPin?: string; adminPassword?: string }
): Promise<{
  settings: { eventName: string; wifiSsid: string; eventPin: string }
  /**
   * Present only when the admin password changed. Changing it revokes every
   * unlock including this one, so the caller must swap in this replacement or
   * its very next request is locked out.
   */
  adminToken?: string
}> {
  return request('/api/admin/settings', {
    method: 'PATCH',
    headers: { ...adminHeaders(auth), 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** The export is downloaded as a blob so the UI can save it as a file. */
export async function adminExport(auth: AdminAuth): Promise<Blob> {
  const res = await fetch(apiUrl('/api/admin/export'), { headers: adminHeaders(auth) })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(data.error ?? `request failed (${res.status})`, res.status)
  }
  return res.blob()
}
