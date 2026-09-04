import { useState } from 'react'
import { useStore } from '../../../store.ts'
import { deliveredNote, deliverText, NO_DOWNLOADS } from '../../../lib/download.ts'
import { APP_VERSION } from '../../../lib/pwa.ts'
import { auditFilename, buildAuditHtml } from '../model/export.ts'
import type { AuditPayload, SeriesPoint } from '../model/types.ts'
import styles from './ExportBar.module.scss'

/**
 * The two ways the audit leaves the pane: a self-contained HTML file to
 * hand to venue IT, and a deep link posted into a channel so the crew can
 * pull it up on their own phones. Both are plain — the download is the
 * four-line blob+anchor pattern; the share is a message the chip renderer
 * already turns into an "Open" button.
 */
export default function ExportBar({
  payload,
  series,
}: {
  payload: AuditPayload
  series: Map<string, SeriesPoint[]>
}) {
  const eventName = useStore((s) => s.config.eventName)
  const channels = useStore((s) => s.channels)
  const sendMessage = useStore((s) => s.sendMessage)
  const [sharing, setSharing] = useState(false)
  const [note, setNote] = useState('')

  async function download() {
    const html = buildAuditHtml(payload, series, {
      eventName,
      version: APP_VERSION,
      generatedAt: payload.report.generatedAt,
    })
    const result = await deliverText(
      auditFilename(payload.report.generatedAt),
      'text/html;charset=utf-8',
      html
    )
    // Sharing the report to a channel works everywhere, and the button for
    // it is right here, so the message points at what to do next.
    setNote(
      result === 'unavailable'
        ? `${NO_DOWNLOADS} Or share it to a channel.`
        : deliveredNote(result, 'Report')
    )
  }

  const publicChannels = Object.values(channels)
    .filter((c) => c.kind === 'public' && !c.retired)
    .sort((a, b) => a.createdAt - b.createdAt)

  const worst = payload.report.networks
    .filter((n) => n.grade !== 'unknown' && n.grade !== 'ok')
    .map((n) => n.label)
  const summary =
    worst.length > 0 ? `Network audit — check ${worst.join(', ')}` : 'Network audit — all good'

  return (
    <section className={styles.bar} aria-label="Export">
      <button className={styles.btn} onClick={() => void download()}>
        Download HTML report
      </button>
      <button className={styles.btn} onClick={() => setSharing((v) => !v)} aria-expanded={sharing}>
        Share to channel
      </button>
      {note && <span className={styles.note}>{note}</span>}
      {sharing && (
        <div className={styles.channels} role="menu">
          {publicChannels.map((channel) => (
            <button
              key={channel.id}
              role="menuitem"
              className={styles.channel}
              onClick={() => {
                sendMessage(channel.id, `📡 ${summary} — /m/network`)
                setSharing(false)
                setNote(`Posted to #${channel.name}`)
              }}
            >
              #{channel.name}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
