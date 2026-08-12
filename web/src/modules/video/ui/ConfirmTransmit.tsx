import type { VideoIntent } from '@crewbox/shared'
import styles from './ConfirmTransmit.module.scss'

/**
 * The second half of the double confirmation, on screen.
 *
 * The box has already been asked what it would send and has answered with
 * `willSend` — the exact traffic, in words somebody could check against a
 * packet capture. This shows those words and asks. Nothing here decides what
 * is allowed; the box does that, and would refuse the follow-up call without
 * the token this dialog holds.
 *
 * Written for the person who will have to answer for it. A festival's network
 * manager asking "what did your box put on my video VLAN" deserves a better
 * answer than "it scanned", and the crew member who pressed the button should
 * have read the real answer before they pressed it.
 */

export default function ConfirmTransmit({
  intent,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  intent: VideoIntent
  busy: boolean
  error: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const heading =
    intent.action === 'scan' ? 'Sweep for LED processors?' : `Start watching ${intent.target}?`

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label={heading}>
      <div className={styles.panel}>
        <h2 className={styles.heading}>{heading}</h2>
        <p className={styles.lead}>
          This puts traffic on the video network. Here is exactly what the box will send
          {intent.action === 'scan' ? ` to ${intent.target}` : ''}:
        </p>
        <ul className={styles.willSend}>
          {intent.willSend.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className={styles.reassure}>
          {intent.action === 'scan'
            ? 'A broadcast with no addressed target — the same packet NovaLCT sends to find controllers. It cannot change what is on a wall.'
            : 'Reads only. There is no way for crewbox to change what is on the wall.'}
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button className={styles.cancel} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className={styles.go} onClick={onConfirm} disabled={busy}>
            {busy ? 'Sending…' : 'Yes, send it'}
          </button>
        </div>
      </div>
    </div>
  )
}
