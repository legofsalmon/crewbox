import type { Channel, FileMeta, Message, User } from '@inter/shared'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
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

export function uploadFile(token: string, file: File): Promise<{ file: FileMeta }> {
  const form = new FormData()
  form.append('file', file)
  return request('/api/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
}

export function voiceToken(
  token: string,
  channelId: string,
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

export function fetchHistory(
  token: string,
  channelId: string,
  beforeSeq: number,
  limit = 100,
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
  patch: { name?: string; topic?: string; retired?: boolean },
): Promise<{ channel: Channel }> {
  return request(`/api/admin/channels/${channelId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** The export is downloaded as a blob so the UI can save it as a file. */
export async function adminExport(token: string): Promise<Blob> {
  const res = await fetch('/api/admin/export', { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(data.error ?? `request failed (${res.status})`, res.status)
  }
  return res.blob()
}
