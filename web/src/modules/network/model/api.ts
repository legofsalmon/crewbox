import { apiUrl } from '../../../lib/server.ts'
import type { AuditPayload, SeriesPoint } from './types.ts'

/**
 * Fetchers for the audit API. Session-authed like the rest of the app —
 * the audit belongs to the whole crew. Kept in the module rather than
 * lib/api.ts so the shell doesn't accrete module-specific calls.
 */

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(apiUrl(path), {
    headers: { authorization: `Bearer ${token}` },
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`)
  return data
}

export function fetchAudit(token: string): Promise<AuditPayload> {
  return get('/api/audit', token)
}

export function fetchSeries(
  token: string,
  metric: string,
  key: string,
  from: number,
  to: number
): Promise<{ points: SeriesPoint[] }> {
  const query = new URLSearchParams({
    metric,
    key,
    from: String(from),
    to: String(to),
  })
  return get(`/api/audit/series?${query}`, token)
}

export function fetchBundle(
  token: string,
  from: number,
  to: number
): Promise<{
  rows: Array<{
    ts: number
    metric: string
    key: string
    min: number
    avg: number
    max: number
    count: number
  }>
}> {
  // Admin-gated and paged since the route could build a festival's week
  // into one response on the box's own event loop. `next` in the reply
  // carries the three values to pass back as the `after*` query parameters.
  return get(`/api/audit/bundle?from=${from}&to=${to}`, token)
}
