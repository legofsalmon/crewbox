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
