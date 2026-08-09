import { useState } from 'react'
import { useStore } from '../../../store.ts'
import { apiUrl } from '../../../lib/server.ts'
import type { ProbeRun } from '../model/types.ts'
import styles from './ProbePanel.module.scss'

/**
 * The deep probe — the audit's one admin-push exception to "never
 * transmit". Rendered only when this browser holds an unlocked admin
 * session; everyone still *sees* the results (they arrive through the
 * report every pane polls), only the button is privileged.
 *
 * The probe log prints each probe's `sent` line verbatim: exactly what the
 * box transmitted, so a strict venue can verify it against a capture.
 */

interface ProbeResultRow {
  id: string
  network: string
  state: string
  sent: string
  detail: string
  fix?: string
}

const ago = (ts: number, now: number): string => {
  const mins = Math.round((now - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 90) return `${mins} min ago`
  return `${Math.round(mins / 60)} h ago`
}

export default function ProbePanel({
  probe,
  probeRunning,
  onStarted,
}: {
  probe: ProbeRun | null
  probeRunning: boolean
  onStarted: () => void
}) {
  const adminToken = useStore((s) => s.adminToken)
  const [note, setNote] = useState('')

  const results: ProbeResultRow[] = (() => {
    const report = probe?.report as { probes?: ProbeResultRow[] } | undefined
    return Array.isArray(report?.probes) ? report.probes : []
  })()

  async function start() {
    setNote('')
    try {
      const res = await fetch(apiUrl('/api/audit/probe'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${localStorage.getItem('crewbox:token') ?? ''}`,
          'x-admin-token': adminToken ?? '',
        },
      })
      if (res.status === 409) setNote('A probe is already running.')
      else if (!res.ok) setNote(`Could not start the probe (${res.status}).`)
      else onStarted()
    } catch {
      setNote('Could not reach the box.')
    }
  }

  return (
    <section className={styles.panel} aria-label="Deep probe">
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>Deep probe</h2>
          <p className={styles.blurb}>
            One admin-triggered sweep: uplink, venue DNS, one Art-Net poll, one mDNS query.
            Everything sent is listed below, verbatim.
          </p>
        </div>
        {adminToken ? (
          <button className={styles.run} onClick={() => void start()} disabled={probeRunning}>
            {probeRunning ? 'Probing…' : 'Run deep probe'}
          </button>
        ) : (
          // Present for everyone, so the section doesn't appear and vanish
          // with other people's actions — only the button is privileged.
          <p className={styles.who}>An admin can run one from their device.</p>
        )}
      </header>
      {note && <p className={styles.note}>{note}</p>}
      {probe && (
        <>
          <p className={styles.meta}>
            {probe.finishedAt
              ? `Last run ${ago(probe.finishedAt, Date.now())} by ${probe.by}.`
              : `Running now (started by ${probe.by})…`}
          </p>
          <ul className={styles.results}>
            {results.map((result) => (
              <li key={result.id} className={styles.result}>
                <div className={styles.detail}>{result.detail}</div>
                {result.fix && <div className={styles.fix}>{result.fix}</div>}
                <div className={styles.sent}>sent: {result.sent}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
