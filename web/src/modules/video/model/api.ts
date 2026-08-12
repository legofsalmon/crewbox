import type { ProcessorStatus, VideoAction, VideoIntent, VideoProcessor } from '@crewbox/shared'
import { apiUrl } from '../../../lib/server.ts'

/**
 * Talking to the box about the video network.
 *
 * Two shapes of call, and the difference matters. `fetchVideoState` is the
 * crew's — session-authed, like the network audit, because a screens tech
 * should be able to read a wall's temperature off their phone without an
 * admin unlock. Everything else needs an admin token, and the two that put a
 * packet on the video network need a confirmation raised first.
 *
 * `raiseIntent` never transmits. It asks the box what a thing *would* send,
 * and comes back with those words plus a single-use token. The token is what
 * the second call carries. See server/src/video/intents.ts for why the split
 * lives on the box rather than in a dialog here.
 */

export interface VideoState {
  processors: ProcessorStatus[]
  scan: {
    at: number
    by: string
    sent: string[]
    found: Array<{ host: string; payload?: string; known: boolean }>
    errors: string[]
  } | null
  scanning: boolean
  canScan: boolean
  interfaceIp: string
}

const sessionToken = (): string => localStorage.getItem('crewbox:token') ?? ''

async function call<T>(
  path: string,
  init: { method: string; adminToken?: string; confirm?: string; body?: unknown }
): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: init.method,
    headers: {
      authorization: `Bearer ${sessionToken()}`,
      ...(init.adminToken ? { 'x-admin-token': init.adminToken } : {}),
      ...(init.confirm ? { 'x-video-confirm': init.confirm } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`)
  return data
}

export function fetchVideoState(): Promise<VideoState> {
  return call<VideoState>('/api/video/state', { method: 'GET' })
}

export function addProcessor(
  adminToken: string,
  host: string,
  name: string
): Promise<{ processor: VideoProcessor }> {
  return call('/api/video/processors', { method: 'POST', adminToken, body: { host, name } })
}

export function removeProcessor(adminToken: string, id: string): Promise<{ removed: boolean }> {
  return call(`/api/video/processors/${id}`, { method: 'DELETE', adminToken })
}

/** Half one: ask what would be sent. Sends nothing itself. */
export function raiseIntent(
  adminToken: string,
  action: VideoAction,
  processorId?: string
): Promise<{ intent: VideoIntent }> {
  return call('/api/video/intent', {
    method: 'POST',
    adminToken,
    body: { action, ...(processorId ? { processorId } : {}) },
  })
}

/** Half two: do it, carrying the token from half one. */
export function runScan(adminToken: string, confirm: string): Promise<{ started: boolean }> {
  return call('/api/video/scan', { method: 'POST', adminToken, confirm })
}

/**
 * Start or stop watching one processor.
 *
 * `confirm` is required to start and meaningless to stop — the box enforces
 * that, and this signature mirrors it rather than pretending both directions
 * are the same shape.
 */
export function setWatching(
  adminToken: string,
  id: string,
  monitored: boolean,
  confirm?: string
): Promise<{ monitored: boolean }> {
  return call(`/api/video/processors/${id}/watch`, {
    method: 'POST',
    adminToken,
    ...(confirm ? { confirm } : {}),
    body: { monitored },
  })
}
