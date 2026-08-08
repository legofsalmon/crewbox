import { useCallback, useEffect, useState } from 'react'
import DrawerButton from '../../shell/DrawerButton.tsx'
import { fetchAudit, fetchSeries } from './model/api.ts'
import { GRADE_LABELS, overallGrade } from './model/grade.ts'
import type { AuditPayload, SeriesPoint } from './model/types.ts'
import EventStrip from './ui/EventStrip.tsx'
import ExportBar from './ui/ExportBar.tsx'
import NetworkCard from './ui/NetworkCard.tsx'
import ProbePanel from './ui/ProbePanel.tsx'
import styles from './NetworkMain.module.scss'

/**
 * The network audit pane: is this site's networking good enough for A/V,
 * and if not, what exactly is wrong and what is the fix.
 *
 * REST polling, not WebSocket push: the report changes on the scale of
 * seconds-to-minutes, so a 10 s poll while the pane is open (paused while
 * the tab is hidden) is the whole transport. A pane nobody has open costs
 * nothing.
 */

const POLL_MS = 10_000
/** Sparkline window: the last hour tells the story at minute resolution. */
const SERIES_WINDOW_MS = 60 * 60_000

const GRADE_CLASS: Record<string, string> = {
  ok: styles.verdictOk!,
  limited: styles.verdictLimited!,
  off: styles.verdictOff!,
  unknown: styles.verdictUnknown!,
}

export default function NetworkMain(_props: { subpath: string }) {
  const [payload, setPayload] = useState<AuditPayload | null>(null)
  const [series, setSeries] = useState<Map<string, SeriesPoint[]>>(new Map())
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const token = localStorage.getItem('crewbox:token') ?? ''
    try {
      const audit = await fetchAudit(token)
      setPayload(audit)
      setError('')
      // Fetch the evidence: every series a finding references, in parallel.
      const wanted = audit.report.networks
        .flatMap((n) => n.findings)
        .flatMap((f) => (f.series ? [f.series] : []))
      const now = Date.now()
      const fetched = await Promise.all(
        wanted.map(async ({ metric, key }): Promise<[string, SeriesPoint[]]> => {
          try {
            const { points } = await fetchSeries(token, metric, key, now - SERIES_WINDOW_MS, now)
            return [`${metric} ${key}`, points]
          } catch {
            return [`${metric} ${key}`, []]
          }
        })
      )
      setSeries(new Map(fetched.filter(([, points]) => points.length > 0)))
    } catch (err) {
      // Offline is the default, not an error state: keep the last report on
      // screen and say the refresh is waiting, rather than blanking the pane.
      setError(err instanceof Error ? err.message : 'audit unavailable')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const grade = payload ? overallGrade(payload.report) : null

  return (
    <div className={styles.pane}>
      <header className={styles.header}>
        <DrawerButton />
        <h1 className={styles.title}>Network</h1>
        {grade && (
          <span className={`${styles.verdict} ${GRADE_CLASS[grade] ?? ''}`}>
            {GRADE_LABELS[grade]}
          </span>
        )}
      </header>

      {error && payload === null && <p className={styles.note}>Waiting for the box: {error}</p>}

      {payload && (
        <div className={styles.body}>
          <ExportBar payload={payload} series={series} />
          <div className={styles.cards}>
            {payload.report.networks.map((network) => (
              <NetworkCard key={network.id} network={network} series={series} />
            ))}
          </div>
          <EventStrip events={payload.events} now={payload.report.generatedAt} />
          <ProbePanel
            probe={payload.probe}
            probeRunning={payload.probeRunning}
            onStarted={() => void load()}
          />
        </div>
      )}
    </div>
  )
}
