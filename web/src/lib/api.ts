import type { Channel, FileMeta, Message, PublicConfig, User } from '@crewbox/shared'
import { apiUrl } from './server.ts'

export type ReadinessState = 'ok' | 'limited' | 'off'

export interface ReadinessCheck {
  id: string
  label: string
  state: ReadinessState
  detail: string
  fix?: string
}

export interface AdminSettings {
  settings: { wifiSsid: string }
  serverInfo: {
    version: string
    uptimeSec: number
    connections: number
    onlineUsers: number
    voiceEnabled: boolean
    eventPin: string
  }
  /** What this box can actually do right now — see server/src/readiness.ts. */
  readiness: ReadinessCheck[]
  readinessState: ReadinessState
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

export function adminResetPin(token: string, userId: string, pin: string): Promise<{ ok: true }> {
  return request(`/api/admin/users/${userId}/pin`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
}

export function adminUpdateChannel(
  token: string,
  channelId: string,
  patch: { name?: string; topic?: string; retired?: boolean }
): Promise<{ channel: Channel }> {
  return request(`/api/admin/channels/${channelId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export function getConfig(): Promise<PublicConfig> {
  return request('/api/config')
}

export function deleteMessage(token: string, messageId: string): Promise<{ ok: true }> {
  return request(`/api/messages/${messageId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
}

/** Permanently delete the signed-in user's own account. */
export function deleteAccount(token: string): Promise<{ ok: true }> {
  return request('/api/me', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
}

export function adminGetSettings(token: string): Promise<AdminSettings> {
  return request('/api/admin/settings', { headers: { authorization: `Bearer ${token}` } })
}

export function adminUpdateSettings(
  token: string,
  patch: { wifiSsid?: string; eventPin?: string }
): Promise<{ settings: { wifiSsid: string; eventPin: string } }> {
  return request('/api/admin/settings', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** The export is downloaded as a blob so the UI can save it as a file. */
export async function adminExport(token: string): Promise<Blob> {
  const res = await fetch(apiUrl('/api/admin/export'), {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(data.error ?? `request failed (${res.status})`, res.status)
  }
  return res.blob()
}
