import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../lib/api.ts'
import { nextPhase, shownStage, type UpdatePhase } from '../lib/updatewatch.ts'
import { adminError } from '../lib/adminerror.ts'

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
  /**
   * What this panel is waiting for, which the box's own stage cannot say.
   * `watching` starts the moment Install is pressed; lib/updatewatch.ts has
   * why the outcome must be polled for rather than read from the reply.
   */
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  const live = useRef(true)

  const refresh = useCallback(
    async (watching = false) => {
      try {
        const next = await api.adminGetUpdate(auth())
        if (!live.current) return
        setStatus(next)
        if (watching) setPhase((p) => nextPhase(p, { kind: 'stage', stage: next.flow.stage }))
      } catch (err) {
        if (!live.current) return
        // A panel that cannot read the updater is not worth a red banner: the
        // rest of the screen is still useful, and the next poll may work. But
        // *which* failure it is decides an install, so it is passed on.
        const locked = err instanceof api.ApiError && err.status === 403
        if (watching) {
          // Deliberately not `adminError`. While an install is being watched
          // a 403 is the good news: unlocks live in one process's memory, so
          // a box holding none of them is a box that restarted, which is the
          // only positive evidence anywhere that the install worked. Giving
          // the unlock back here would replace "the box came back on 0.19.0"
          // with the password box.
          setPhase((p) => nextPhase(p, locked ? { kind: 'locked' } : { kind: 'silent' }))
        } else if (locked) {
          // Not watching: an ordinary dead unlock, and the rest of the panel
          // is about to fail the same way.
          adminError(err, '')
        }
      }
    },
    [auth]
  )

  useEffect(() => {
    live.current = true
    void refresh()
    return () => {
      live.current = false
    }
  }, [refresh])

  // Poll only while something is actually moving. A box sitting idle has no
  // reason to be asked twice a second for ever.
  //
  // `phase` is in here because the local stage is still `ready` at the moment
  // Install is pressed — the box goes off the air before it can say
  // otherwise. Without it nothing polled, and a rollback was never read.
  const moving =
    status?.flow.stage === 'downloading' ||
    status?.flow.stage === 'installing' ||
    phase === 'watching'
  useEffect(() => {
    if (!moving) return
    const watchingInstall = phase === 'watching'
    const timer = setInterval(() => void refresh(watchingInstall), POLL_MS)
    return () => clearInterval(timer)
  }, [moving, phase, refresh])

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

  const shown = shownStage(phase, flow.stage)

  async function download() {
    if (!available) return
    setBusy(true)
    try {
      await api.adminDownloadUpdate(auth(), available.version)
      await refresh()
    } catch (err) {
      onNote(adminError(err, 'Could not start the download'))
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
      onNote(adminError(err, 'Could not prepare the update'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Start the install, then stop believing this request.
   *
   * Releasing the port destroys the socket carrying it, so the *successful*
   * case can never reply and the 500 a rollback produces cannot get back
   * either. Reading the rejection as "the box is restarting" is how a
   * rollback used to be reported to the admin as a completed update. The poll
   * decides instead, which is why the phase is set before the request rather
   * than after it.
   */
  async function install() {
    if (!intent) return
    setIntent(null)
    setPhase('watching')
    try {
      await api.adminInstallUpdate(auth(), intent.version, intent.token)
    } catch {
      // Expected on every path worth having, and evidence of nothing.
    }
    await refresh(true)
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
          {shown === 'idle' && available && (
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

          {shown === 'downloading' && (
            <p className="admin-updater-lead" aria-live="polite">
              Downloading {version} and checking its signature…
            </p>
          )}

          {shown === 'ready' && (
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

          {shown === 'installing' && (
            <p className="admin-updater-lead" aria-live="polite">
              Installing {version}. The box is restarting — this page is watching for it to come
              back and will say how it went.
            </p>
          )}

          {shown === 'restarted' && (
            <>
              <p className="admin-updater-lead" aria-live="polite">
                The box came back on <strong>{version}</strong>.
              </p>
              <p className="admin-hint">
                It is a new process, so the panel is locked again and everything on this screen is
                from before the restart.
              </p>
              <button className="admin-btn" onClick={() => location.reload()}>
                Reload the panel
              </button>
            </>
          )}

          {shown === 'failed' && (
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
