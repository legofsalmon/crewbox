import { GRADE_LABELS } from '../model/grade.ts'
import type { AuditNetwork, SeriesPoint } from '../model/types.ts'
import FindingRow from './FindingRow.tsx'
import styles from './NetworkCard.module.scss'

/** Units for the number beside a sparkline, by metric. */
const METRIC_UNITS: Record<string, string> = {
  'crew.rtt': ' ms',
  'dmx.rateHz': ' Hz',
  'dmx.lossPct': '%',
}

const GRADE_CLASS: Record<AuditNetwork['grade'], string> = {
  ok: styles.gradeOk!,
  limited: styles.gradeLimited!,
  off: styles.gradeOff!,
  unknown: styles.gradeUnknown!,
}

/**
 * One network's card: the verdict up top, the findings under it, each with
 * its evidence sparkline when history exists for it.
 */
export default function NetworkCard({
  network,
  series,
}: {
  network: AuditNetwork
  /** Fetched series keyed `metric key` — the card looks its findings up. */
  series: Map<string, SeriesPoint[]>
}) {
  return (
    <section className={styles.card} aria-label={network.label}>
      <header className={styles.head}>
        <h2 className={styles.title}>{network.label}</h2>
        <span className={`${styles.grade} ${GRADE_CLASS[network.grade]}`}>
          {GRADE_LABELS[network.grade]}
        </span>
      </header>
      <ul className={styles.findings}>
        {network.findings.map((finding) => {
          const key = finding.series ? `${finding.series.metric} ${finding.series.key}` : ''
          const props = {
            finding,
            ...(key && series.has(key) ? { points: series.get(key)! } : {}),
            ...(finding.series ? { unit: METRIC_UNITS[finding.series.metric] ?? '' } : {}),
          }
          return <FindingRow key={finding.id} {...props} />
        })}
      </ul>
    </section>
  )
}
