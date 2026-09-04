import type { AuditReport, NetworkGrade } from './types.ts'

/**
 * How a grade reads on the pane. The words carry the judgement; colour
 * only underlines it (and `unknown` must never look like a fault — a box
 * that isn't watching a network has nothing bad to say about it).
 */
export const GRADE_LABELS: Record<NetworkGrade, string> = {
  ok: 'Good for A/V',
  limited: 'Usable — fixes below',
  off: 'Not suitable right now',
  unknown: 'Not watched',
}

/** The overall verdict: worst watched network; unknowns don't drag it down. */
export function overallGrade(report: AuditReport): NetworkGrade {
  let grade: NetworkGrade = 'unknown'
  for (const network of report.networks) {
    if (network.grade === 'unknown') continue
    if (network.grade === 'off') return 'off'
    if (network.grade === 'limited') grade = 'limited'
    else if (grade === 'unknown') grade = 'ok'
  }
  return grade
}

/**
 * Every series the report's findings cite, once each.
 *
 * Two findings on one network routinely reference the same series — a loss
 * figure and the latency beside it — and the pane fetched one query per
 * finding, so each duplicate was a second identical query against the box's
 * rollups every ten seconds for as long as somebody had the pane open.
 * A festival's worth of findings across three networks made that a
 * measurable share of what a box does while a show is running.
 */
export function seriesWanted(report: AuditReport): Array<{ metric: string; key: string }> {
  const seen = new Map<string, { metric: string; key: string }>()
  for (const network of report.networks) {
    for (const finding of network.findings) {
      if (finding.series) seen.set(`${finding.series.metric}|${finding.series.key}`, finding.series)
    }
  }
  return [...seen.values()]
}
