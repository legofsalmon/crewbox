import { useEffect, useState } from 'react'
import { useStore, sessionToken } from '../store.ts'
import { adminGetLicence } from '../lib/api.ts'
import { FEEDBACK_TYPES, sendFeedback, type FeedbackType, type Outcome } from '../lib/reports.ts'

const TYPE_LABELS: Record<FeedbackType, string> = {
  bug: 'Something’s broken',
  idea: 'An idea',
  question: 'A question',
  praise: 'Something’s good',
}

/**
 * "Send feedback…": a bug, an idea, a question or some praise, to the people
 * who make Crewbox.
 *
 * It goes to the crew box, which sends it on when it has internet — so this
 * works in a field, and says honestly that it will arrive later. What is sent
 * is what is on the form: no name, no event, no messages. The two ticks are
 * the only way anything more goes, and both start empty.
 *
 * The licence tick is only offered to an unlocked admin on a licensed box.
 * The box's licence is the organiser's, not a crew member's, and the key is
 * added by the box itself; it is never sent to this device.
 */
export default function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const adminToken = useStore((s) => s.adminToken)
  const [type, setType] = useState<FeedbackType>('idea')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [isPublic, setIsPublic] = useState(false)
  const [includeLicence, setIncludeLicence] = useState(false)
  const [licensed, setLicensed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  useEffect(() => {
    if (!adminToken) return
    let live = true
    adminGetLicence({ token: sessionToken() ?? '', adminToken })
      .then(({ licence }) => {
        if (live) setLicensed(licence.key !== null || licence.licence !== null)
      })
      // No licence section on this box, or the unlock lapsed: no tick.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [adminToken])

  const canSend = message.trim().length > 0 && !busy

  async function onSend() {
    if (!canSend) return
    setBusy(true)
    setOutcome(
      await sendFeedback(
        {
          type,
          message: message.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          public: isPublic,
          includeLicence: licensed && includeLicence,
        },
        sessionToken() ?? '',
        adminToken
      )
    )
    setBusy(false)
  }

  const done = outcome === 'sent' || outcome === 'saved'

  return (
    <div
      className="search-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
      onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}
    >
      <div className="confirm-panel feedback-panel" role="dialog" aria-label="Send feedback">
        <h3>Send feedback</h3>
        {done ? (
          <>
            <p>
              {outcome === 'sent'
                ? 'Thanks — the crew box has it and will pass it on to LeTissier Creative Studios when it next has internet.'
                : 'Saved on this device. It goes to the crew box as soon as the app can reach it, and on from there.'}
            </p>
            <div className="confirm-actions">
              <button className="confirm-send" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              To the people who make Crewbox. It goes through this event’s crew box, so it may
              arrive after the show.
            </p>
            <fieldset className="feedback-types">
              <legend>What is it?</legend>
              {FEEDBACK_TYPES.map((value) => (
                <label key={value} className="feedback-type">
                  <input
                    type="radio"
                    name="feedback-type"
                    value={value}
                    checked={type === value}
                    onChange={() => setType(value)}
                    disabled={busy}
                  />
                  {TYPE_LABELS[value]}
                </label>
              ))}
            </fieldset>
            <label className="confirm-field">
              Message
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={5000}
                rows={5}
                disabled={busy}
              />
            </label>
            <label className="confirm-field">
              Your email, if you’d like a reply (optional)
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={254}
                autoComplete="email"
                disabled={busy}
              />
            </label>
            {licensed && (
              <label className="feedback-tick">
                <input
                  type="checkbox"
                  checked={includeLicence}
                  onChange={(e) => setIncludeLicence(e.target.checked)}
                  disabled={busy}
                />
                Include my licence so you know who I am
              </label>
            )}
            <label className="feedback-tick">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
                disabled={busy}
              />
              OK to post this publicly on the issue tracker, without my name or email
            </label>
            {outcome && typeof outcome === 'object' && (
              <div className="join-error">{outcome.refused}</div>
            )}
            <div className="confirm-actions">
              <button className="confirm-cancel" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="confirm-send" onClick={() => void onSend()} disabled={!canSend}>
                {busy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
