import type { AuditFinding, SeriesPoint } from '../model/types.ts'
import Sparkline from './Sparkline.tsx'
import styles from './FindingRow.module.scss'

/**
 * One finding, in the readiness panels' vocabulary — the same glyphs and
 * the same state words the admin already reads, so nobody learns a second
 * language. When the finding references a series and the pane has fetched
 * it, the sparkline sits beside the sentence: the graph is the evidence,
 * the sentence is the verdict.
 */

const STATE_LABEL: Record<AuditFinding['state'], string> = {
  ok: 'Working',
  limited: 'Limited',
  off: 'Fault',
  info: 'For information',
}

const STATE_DOT: Record<AuditFinding['state'], string> = {
  ok: '●',
  limited: '◐',
  off: '○',
  info: '·',
}

const STATE_CLASS: Record<AuditFinding['state'], string> = {
  ok: styles.ok!,
  limited: styles.limited!,
  off: styles.off!,
  info: styles.info!,
}

export default function FindingRow({
  finding,
  points,
  unit,
}: {
  finding: AuditFinding
  /** Series data for the sparkline, when the pane has it. */
  points?: SeriesPoint[]
  unit?: string
}) {
  return (
    <li className={`${styles.row} ${STATE_CLASS[finding.state]}`}>
      <span className={styles.state} aria-label={STATE_LABEL[finding.state]}>
        {STATE_DOT[finding.state]}
      </span>
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.label}>{finding.label}</span>
          {points && points.length > 0 && (
            <Sparkline points={points} label={finding.label} unit={unit ?? ''} />
          )}
        </div>
        <div className={styles.detail}>{finding.detail}</div>
        {finding.fix && <div className={styles.fix}>{finding.fix}</div>}
      </div>
    </li>
  )
}
