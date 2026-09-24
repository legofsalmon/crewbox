import { useState, type FormEvent } from 'react'
import * as api from '../lib/api.ts'
import { adminError } from '../lib/adminerror.ts'
import { formatDay, licenceSummary, offerActivation } from '../lib/licence.ts'

/**
 * The box's licence: what it has, and every way to give it one.
 *
 * Offline activation sits beside the key field rather than behind an error,
 * because a festival box is offline more often than not and the owner may be
 * holding a phone with signal while the box has none. Nothing in here can
 * touch the crew: the worst any state does is a banner on this panel and a
 * line in the drawer.
 */
export default function LicenceSection({
  licence,
  auth,
  onLicence,
  onNote,
}: {
  licence: api.LicenceStatus
  auth: () => api.AdminAuth
  onLicence: (licence: api.LicenceStatus) => void
  onNote: (note: string) => void
}) {
  const [key, setKey] = useState('')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmRelease, setConfirmRelease] = useState(false)

  const summary = licenceSummary(licence)
  const offer = offerActivation(licence)

  async function run(
    action: () => Promise<{ licence: api.LicenceStatus }>,
    done: (licence: api.LicenceStatus) => string,
    fallback: string
  ): Promise<boolean> {
    setBusy(true)
    try {
      const { licence: next } = await action()
      onLicence(next)
      onNote(done(next))
      return true
    } catch (err) {
      onNote(adminError(err, fallback))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function activate(e: FormEvent) {
    e.preventDefault()
    const ok = await run(
      () => api.adminActivateLicence(auth(), key.trim()),
      () => 'Licence activated on this box',
      'Activation failed'
    )
    if (ok) setKey('')
  }

  async function trial(e: FormEvent) {
    e.preventDefault()
    await run(
      () => api.adminStartTrial(auth(), email.trim(), name.trim() || undefined),
      (next) =>
        `Trial started${next.licence ? ` — it ends ${formatDay(next.licence.checkInBy)}` : ''}`,
      'Could not start the trial'
    )
  }

  async function paste(e: FormEvent) {
    e.preventDefault()
    const ok = await run(
      () => api.adminPasteLicenceToken(auth(), token),
      () => 'Licence token accepted',
      'That token was not accepted'
    )
    if (ok) setToken('')
  }

  async function checkIn() {
    await run(
      () => api.adminCheckInLicence(auth()),
      () => 'Checked in with the licence service',
      'Check-in failed'
    )
  }

  async function release() {
    if (!confirmRelease) {
      setConfirmRelease(true)
      return
    }
    setBusy(true)
    try {
      const { licence: next, released } = await api.adminReleaseLicence(auth())
      onLicence(next)
      onNote(
        released
          ? 'Licence released — the seat is free for another box'
          : 'Licence removed from this box. It could not reach the service, so free the seat from your account page.'
      )
    } catch (err) {
      onNote(adminError(err, 'Release failed'))
    } finally {
      setBusy(false)
      setConfirmRelease(false)
    }
  }

  return (
    <div className="admin-licence" id="admin-licence">
      <p className={`admin-licence-status admin-licence-${summary.tone}`}>
        <strong>{summary.headline}</strong>
        <span>{summary.detail}</span>
      </p>

      <dl className="admin-info">
        {licence.key && (
          <div>
            <dt>Key</dt>
            <dd className="admin-key">{licence.key}</dd>
          </div>
        )}
        {licence.machine && (
          <div>
            <dt>This box</dt>
            <dd className="admin-key">{licence.machine}</dd>
          </div>
        )}
        {licence.lastCheckIn && (
          <div>
            <dt>Last check-in</dt>
            <dd>
              {licence.lastCheckIn.ok
                ? new Date(licence.lastCheckIn.at).toLocaleString()
                : `Failed — ${licence.lastCheckIn.error ?? 'no answer'}`}
            </dd>
          </div>
        )}
      </dl>

      {licence.key && (
        <div className="admin-licence-actions">
          <button className="admin-btn" disabled={busy} onClick={() => void checkIn()}>
            Check in now
          </button>
          <button
            className={`admin-btn danger ${confirmRelease ? 'confirm' : ''}`}
            disabled={busy}
            onClick={() => void release()}
          >
            {confirmRelease ? 'Really release?' : 'Release this box'}
          </button>
        </div>
      )}

      {offer && (
        <>
          <form className="admin-setting" onSubmit={(e) => void activate(e)}>
            <label htmlFor="admin-licence-key">Licence key</label>
            <div className="admin-setting-row">
              <input
                id="admin-licence-key"
                value={key}
                maxLength={64}
                placeholder="LT-CREW-XXXX-XXXX-XXXX"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                onChange={(e) => setKey(e.target.value)}
              />
              <button className="admin-btn" type="submit" disabled={busy || !key.trim()}>
                Activate
              </button>
            </div>
            <p className="admin-muted">
              Needs the box to reach the internet. No signal? See below.
            </p>
          </form>

          {!licence.key && (
            <form className="admin-setting" onSubmit={(e) => void trial(e)}>
              <label htmlFor="admin-licence-email">Start a 30-day trial</label>
              <div className="admin-setting-row">
                <input
                  id="admin-licence-email"
                  type="email"
                  value={email}
                  maxLength={254}
                  placeholder="you@example.com"
                  autoComplete="email"
                  onChange={(e) => setEmail(e.target.value)}
                />
                <button className="admin-btn" type="submit" disabled={busy || !email.trim()}>
                  Start trial
                </button>
              </div>
              <input
                aria-label="Your name (optional)"
                className="admin-licence-name"
                value={name}
                maxLength={120}
                placeholder="Your name (optional)"
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
              />
              <p className="admin-muted">One trial per box. Needs the box to reach the internet.</p>
            </form>
          )}
        </>
      )}

      <details className="admin-licence-offline" open={offer && !licence.key}>
        <summary>No internet here? Activate offline</summary>
        {licence.requestCode ? (
          <>
            <ol className="admin-licence-steps">
              <li>
                On any device with signal, sign in at{' '}
                <a href={licence.manageUrl} target="_blank" rel="noreferrer">
                  letissier.ie/account
                </a>{' '}
                and pick your licence.
              </li>
              <li>
                Enter this box&rsquo;s request code:
                <code className="admin-key admin-licence-code">{licence.requestCode}</code>
              </li>
              <li>Paste the token it gives you here.</li>
            </ol>
            <form className="admin-setting" onSubmit={(e) => void paste(e)}>
              <label htmlFor="admin-licence-token">Licence token</label>
              <textarea
                id="admin-licence-token"
                className="admin-licence-token"
                value={token}
                rows={3}
                spellCheck={false}
                autoCapitalize="none"
                onChange={(e) => setToken(e.target.value)}
              />
              <button
                className="admin-btn admin-licence-use"
                type="submit"
                disabled={busy || !token.trim()}
              >
                Use this token
              </button>
            </form>
          </>
        ) : (
          <p className="admin-hint">
            This box can&rsquo;t read its own machine id, so it can&rsquo;t be licensed. Nothing
            else is affected.
          </p>
        )}
      </details>
    </div>
  )
}
