import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../lib/api.ts'

/**
 * Updating the box, from the panel.
 *
 * Three deliberate shapes here, all of them about not surprising somebody at
 * two in the morning.
 *
 * **A box with nothing to do says nothing.** No "up to date" row: a row that
 * is almost always the same word is a row nobody reads, and the one time it
 * changes nobody notices either.
 *
 * **Downloading and installing are separate buttons.** Fetching two hundred
 * megabytes is reversible and costs a venue's uplink; restarting takes every
 * phone on site offline. Rolling those into one press would mean the decision
 * to interrupt a show gets made at the moment somebody was only curious.
 *
 * **The confirmation is not "are you sure".** It is a list of what is
 * currently on and who is connected, from the box, because that is the only
 * version of the question anybody can actually answer.
 */

const POLL_MS = 1500

export default function UpdateSection({
  auth,
  onNote,
}: {
  auth: () => api.AdminAuth
  onNote: (note: string) => void
}) {
  const [status, setStatus] = useState<api.UpdateStatus | null>(null)
  const [intent, setIntent] = useState<{
    token: string
    version: string
    interruption: api.Interruption
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const live = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await api.adminGetUpdate(auth())
      if (live.current) setStatus(next)
    } catch {
      // A panel that cannot read the updater is not worth a red banner: the
      // rest of the screen is still useful, and the next poll may work.
    }
  }, [auth])

  useEffect(() => {
    live.current = true
    void refresh()
    return () => {
      live.current = false
    }
  }, [refresh])

  // Poll only while something is actually moving. A box sitting idle has no
  // reason to be asked twice a second for ever.
  const moving = status?.flow.stage === 'downloading' || status?.flow.stage === 'installing'
  useEffect(() => {
    if (!moving) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [moving, refresh])

  if (!status) return null
  const { flow, available, interruption } = status

  // Nothing to say: no news, nothing downloaded, nothing broken. The row
  // simply is not there.
  //
  // That covers a box which cannot update itself *and* has no update to
  // ignore — a developer running from source, most of the time. The reason is
  // worth saying only when somebody would otherwise be looking for a button:
  // a version they can see is available, and no way to act on it. A permanent
  // "this runs from source" line on every dev box would be noise, and noise on
  // this screen is what stops the real rows being read.
  if (!available && flow.stage === 'idle' && !flow.build) return null

  const version = flow.version ?? available?.version ?? ''

  async function download() {
    if (!available) return
    setBusy(true)
    try {
      await api.adminDownloadUpdate(auth(), available.version)
      await refresh()
    } catch (err) {
      onNote(err instanceof api.ApiError ? err.message : 'Could not start the download')
    } finally {
      setBusy(false)
    }
  }

  async function arm() {
    setBusy(true)
    try {
      const { intent: armed } = await api.adminArmUpdate(auth(), version)
      setIntent(armed)
    } catch (err) {
      onNote(err instanceof api.ApiError ? err.message : 'Could not prepare the update')
    } finally {
      setBusy(false)
    }
  }

  async function install() {
    if (!intent) return
    setBusy(true)
    try {
      await api.adminInstallUpdate(auth(), intent.version, intent.token)
      // Reaching here means the install *returned*, which only happens when
      // something went wrong — on success the box is gone and this request
      // died with it. Refresh to read the failure.
      await refresh()
    } catch (err) {
      // Very likely the connection dropping as the box restarts, which is the
      // good outcome. The panel cannot tell the difference from here, so it
      // says the honest thing and lets the reconnect answer it.
      onNote(
        err instanceof api.ApiError && err.status
          ? err.message
          : 'The box is restarting — this page will reconnect on its own'
      )
    } finally {
      setIntent(null)
      setBusy(false)
    }
  }

  async function reset() {
    setBusy(true)
    try {
      await api.adminResetUpdate(auth())
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="admin-updater">
      {flow.blocked ? (
        <p className="admin-hint">{flow.blocked}</p>
      ) : (
        <>
          {flow.stage === 'idle' && available && (
            <>
              <p className="admin-updater-lead">
                <strong>{available.version}</strong> is available.{' '}
                <a href={available.url} target="_blank" rel="noreferrer">
                  What changed
                </a>
              </p>
              <p className="admin-hint">
                Downloading changes nothing on this box — it fetches the build and checks it was
                signed by us. Installing is a separate decision.
              </p>
              <button className="admin-btn" onClick={() => void download()} disabled={busy}>
                Download {available.version}
              </button>
            </>
          )}

          {flow.stage === 'downloading' && (
            <p className="admin-updater-lead" aria-live="polite">
              Downloading {version} and checking its signature…
            </p>
          )}

          {flow.stage === 'ready' && (
            <>
              <p className="admin-updater-lead">
                <strong>{version}</strong> is downloaded and verified.
              </p>
              <p className="admin-hint">
                Installing restarts the box. Everyone loses comms for about{' '}
                {interruption.outageSeconds} seconds.
              </p>
              <button className="admin-btn" onClick={() => void arm()} disabled={busy}>
                Install and restart…
              </button>
            </>
          )}

          {flow.stage === 'installing' && (
            <p className="admin-updater-lead" aria-live="polite">
              Installing {version}. The box is restarting — this page will reconnect on its own.
            </p>
          )}

          {flow.stage === 'failed' && (
            <>
              <p className="admin-updater-error" role="alert">
                {flow.error}
              </p>
              <button className="admin-btn" onClick={() => void reset()} disabled={busy}>
                Try again
              </button>
            </>
          )}
        </>
      )}

      {intent && (
        <div
          className="admin-updater-confirm"
          role="dialog"
          aria-modal="true"
          aria-label={`Install ${intent.version} and restart?`}
        >
          <div className="admin-updater-confirm-panel">
            <h2>Install {intent.version} and restart?</h2>
            <p className="admin-hint">Here is what that interrupts, right now:</p>
            <ul className="admin-updater-lines">
              {intent.interruption.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="admin-hint">
              The database is copied first, and if the new version will not start the box puts the
              old one back on its own.
            </p>
            <div className="admin-updater-actions">
              <button className="admin-btn" onClick={() => setIntent(null)} disabled={busy}>
                Not now
              </button>
              <button
                className="admin-btn admin-btn-primary"
                onClick={() => void install()}
                disabled={busy}
              >
                Install now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
