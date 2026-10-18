import { useState, type FormEvent } from 'react'
import { useStore } from '../store.ts'
import { ApiError } from '../lib/api.ts'

/**
 * The password gate in front of Settings → Admin.
 *
 * Admin used to be a property of a person — the first crew member to join
 * got it, permanently, and took it with them if they ever deleted their
 * account, leaving the box with no way in at all. It is now something anyone
 * can unlock by knowing the password, which is why the tab is there for
 * everyone: a control nobody can find is how a box loses its admin.
 *
 * The token this returns lives in memory only, so closing the app locks the
 * panel again without anyone having to remember to.
 */
export default function AdminUnlock() {
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
    <div className="admin-scroll">
      <form
        className="admin-unlock-form"
        aria-label="Unlock admin"
        onSubmit={(e) => void submit(e)}
      >
        <p className="admin-hint admin-unlock-why">
          The box’s own settings: crew, channels, networks, backups and updates.
        </p>
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
        {/*
         * Not the event PIN, and people will try the event PIN first. And
         * not always written down: a Mac box has no console to print it
         * to, so the way back in is said here, where it is missed.
         */}
        <p className="admin-muted">
          Not the event PIN. Lost it? On the box itself, choose{' '}
          <strong>Open the admin panel</strong> from the Crewbox icon beside the clock or in the
          tray, then set a new one under This box.
        </p>
        {error && (
          <p className="admin-error" role="alert">
            {error}
          </p>
        )}
        <button className="admin-btn admin-btn-primary" type="submit" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
