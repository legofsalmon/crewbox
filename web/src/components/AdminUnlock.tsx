import { useState, type FormEvent } from 'react'
import { useStore } from '../store.ts'
import { ApiError } from '../lib/api.ts'

const PIN_RE = /^\d{4,8}$/

/**
 * The gate in front of Settings → Admin.
 *
 * Admin used to be a property of a person — the first crew member to join
 * got it, permanently, and took it with them if they ever deleted their
 * account, leaving the box with no way in at all. It then became something
 * anyone can unlock by knowing the password, which is why the tab is there
 * for everyone: a control nobody can find is how a box loses its admin.
 *
 * It is a person again, but only one an admin chose, and never the only way
 * in: somebody made an admin opens it with their own PIN, the one they sign
 * in with, and the password and the admin link on the box still work for
 * anyone. So the PIN is what an admin is asked for, and the password is one
 * press away for the day they need it.
 *
 * The token this returns lives in memory only, so closing the app locks the
 * panel again without anyone having to remember to. The PIN is asked again
 * for the same reason the password was: a phone left on a table is signed
 * in, and should not also be an admin.
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
  const isAdmin = useStore((s) => s.me?.role === 'admin')
  /** An admin who chose the box's password instead of their PIN. */
  const [usePassword, setUsePassword] = useState(false)
  const byPin = isAdmin && !usePassword
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || !password) return
    if (byPin && !PIN_RE.test(password)) {
      setError('Your PIN is 4 to 8 digits, the one you sign in with.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await unlockAdmin(byPin ? { pin: password } : { password })
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
        <label htmlFor="admin-password">{byPin ? 'Your PIN' : 'Admin password'}</label>
        <input
          // A new element when the field changes what it is for, so the
          // browser forgets what was typed into the other one.
          key={byPin ? 'pin' : 'password'}
          id="admin-password"
          type="password"
          autoFocus
          value={password}
          disabled={busy}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          {...(byPin ? { inputMode: 'numeric' as const, maxLength: 8 } : {})}
          placeholder={byPin ? 'the PIN you sign in with' : "the box's admin password"}
          onChange={(e) => setPassword(byPin ? e.target.value.replace(/\D/g, '') : e.target.value)}
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
        {byPin ? (
          <p className="admin-muted">
            You're an admin on this box, so your own PIN opens it.{' '}
            <button
              type="button"
              className="admin-link-btn"
              onClick={() => {
                setUsePassword(true)
                setPassword('')
                setError(null)
              }}
            >
              Use the box's admin password
            </button>
          </p>
        ) : (
          <p className="admin-muted">
            Not the event PIN. Lost it? On the box itself, choose{' '}
            <strong>Open the admin panel</strong> from the Crewbox icon beside the clock or in the
            tray, then set a new one under This box. An admin can also make you one, so your own PIN
            opens this.
          </p>
        )}
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
