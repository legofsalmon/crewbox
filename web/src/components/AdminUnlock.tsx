import { useState, type FormEvent } from 'react'
import { useStore } from '../store.ts'
import { ApiError } from '../lib/api.ts'

/**
 * The password gate in front of the admin panel.
 *
 * Admin used to be a property of a person — the first crew member to join
 * got it, permanently, and took it with them if they ever deleted their
 * account, leaving the box with no way in at all. It is now something anyone
 * can unlock by knowing the password, which is why the cog is visible to
 * everyone: a control nobody can find is how a box loses its admin.
 *
 * The token this returns lives in memory only, so closing the app locks the
 * panel again without anyone having to remember to.
 */
export default function AdminUnlock() {
  const setAdminOpen = useStore((s) => s.setAdminOpen)
  const unlockAdmin = useStore((s) => s.unlockAdmin)
  /**
   * Why the panel locked itself, when it did rather than being locked by
   * somebody. Without this the screen simply reappears mid-task, which reads
   * as the box having thrown you out for no reason — most often it is a
   * restart, which is exactly the thing worth saying.
   */
  const lockedReason = useStore((s) => s.adminLockedReason)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || !password) return
    setBusy(true)
    setError(null)
    try {
      await unlockAdmin(password)
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the box — are you still online?'
      )
      setPassword('')
      setBusy(false)
    }
  }

  return (
    <div
      className="admin-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setAdminOpen(false)
      }}
      onKeyDown={(e) => e.key === 'Escape' && setAdminOpen(false)}
    >
      <div className="admin-panel admin-unlock" role="dialog" aria-label="Unlock admin panel">
        <header className="admin-head">
          <h2>Admin</h2>
          <button className="icon-btn" aria-label="Close" onClick={() => setAdminOpen(false)}>
            ✕
          </button>
        </header>
        <form className="admin-unlock-form" onSubmit={(e) => void submit(e)}>
          <label htmlFor="admin-password">Admin password</label>
          <input
            id="admin-password"
            type="password"
            autoFocus
            value={password}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="the box's admin password"
            onChange={(e) => setPassword(e.target.value)}
          />
          {lockedReason && !error && (
            <p className="admin-note" role="status">
              {lockedReason}
            </p>
          )}
          {/* Not the event PIN, and people will try the event PIN first. */}
          <p className="admin-muted">
            Not the event PIN. The box printed this when it first started, and it can be changed
            here once you&rsquo;re in.
          </p>
          {error && (
            <p className="admin-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="admin-btn admin-btn-primary"
            type="submit"
            disabled={busy || !password}
          >
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  )
}
