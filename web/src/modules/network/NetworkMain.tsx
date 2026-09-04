import { useCallback, useEffect, useState } from 'react'
import DrawerButton from '../../shell/DrawerButton.tsx'
import { fetchAudit, fetchSeries } from './model/api.ts'
import { reportAge } from './model/age.ts'
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
  // Ticks the age line while the pane is open, independent of the poll —
  // which is the case that matters, because a poll that is failing is
  // exactly when the number needs to keep climbing.
  const [now, setNow] = useState(() => Date.now())

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
    // A tab that has been in the background is showing a report from
    // whenever it was last foregrounded, so ask again the moment somebody
    // looks rather than up to ten seconds later.
    const onVisible = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(tick)
  }, [])

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
        {payload && (
          <span className={styles.age} title={new Date(payload.report.generatedAt).toISOString()}>
            {reportAge(payload.report.generatedAt, now)}
          </span>
        )}
      </header>

      {/*
        A report on screen is a report from *some* moment, and once the pane
        has one it kept showing it with nothing saying the refreshes had
        stopped — so a crew chief could be reading a green verdict from
        before the switch was unplugged. The age line is always there and the
        note appears whenever a refresh is failing, whether or not there is
        something to look at behind it.
      */}
      {error && <p className={styles.note}>Waiting for the box: {error}</p>}

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
