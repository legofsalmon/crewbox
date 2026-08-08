/**
 * Client-side shapes of the audit API. Re-declared rather than shared with
 * the server, the same way the admin payloads are in lib/api.ts — REST
 * payload types live with their consumers.
 */

export type FindingState = 'ok' | 'info' | 'limited' | 'off'
export type NetworkGrade = 'ok' | 'limited' | 'off' | 'unknown'

export interface AuditFinding {
  id: string
  label: string
  state: FindingState
  detail: string
  fix?: string
  /** Series backing this finding — the sparkline drawn beside the row. */
  series?: { metric: string; key: string }
}

export interface AuditNetwork {
  id: 'crew' | 'lighting' | 'media'
  label: string
  grade: NetworkGrade
  findings: AuditFinding[]
}

export interface AuditReport {
  generatedAt: number
  networks: AuditNetwork[]
}

export interface AuditEvent {
  id: string
  at: number
  network: 'crew' | 'lighting' | 'media'
  kind: string
  key: string
  detail: string
}

export interface ProbeRun {
  id: string
  startedAt: number
  finishedAt: number | null
  by: string
  report: unknown
}

export interface AuditPayload {
  report: AuditReport
  events: AuditEvent[]
  probe: ProbeRun | null
  probeRunning: boolean
}

/** One rollup bucket on the wire: [ts, min, avg, max, count]. */
export type SeriesPoint = [number, number, number, number, number]
