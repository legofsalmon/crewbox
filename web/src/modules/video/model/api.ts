import type { ProcessorStatus, VideoAction, VideoIntent, VideoProcessor } from '@crewbox/shared'
import { apiUrl } from '../../../lib/server.ts'

/**
 * Talking to the box about the video network.
 *
 * Everything here is a read except one call. Naming a processor and watching
 * it produces addressed GETs, so those are session-authed like the rest of
 * the app — a screens tech should not need an admin unlock to look at their
 * own wall. `runScan` is the exception: a broadcast across a whole segment is
 * a decision about somebody else's network, so it carries the admin token.
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

export function addProcessor(host: string, name: string): Promise<{ processor: VideoProcessor }> {
  return call('/api/video/processors', { method: 'POST', body: { host, name } })
}

export function removeProcessor(id: string): Promise<{ removed: boolean }> {
  return call(`/api/video/processors/${id}`, { method: 'DELETE' })
}

/**
 * Half one: ask what would be sent. Sends nothing itself.
 *
 * `adminToken` is only meaningful for a sweep, and the box enforces that —
 * it will not hand out a scan token to a plain session, so this cannot be
 * used to get round the password on the sweep itself.
 */
export function raiseIntent(
  action: VideoAction,
  processorId?: string,
  adminToken?: string
): Promise<{ intent: VideoIntent }> {
  return call('/api/video/intent', {
    method: 'POST',
    ...(adminToken ? { adminToken } : {}),
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
  id: string,
  monitored: boolean,
  confirm?: string
): Promise<{ monitored: boolean }> {
  return call(`/api/video/processors/${id}/watch`, {
    method: 'POST',
    ...(confirm ? { confirm } : {}),
    body: { monitored },
  })
}
