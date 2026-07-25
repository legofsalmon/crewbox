import { useState } from 'react'
import { useStore } from '../store.ts'

/**
 * Confirmed self-service account deletion (App Store requirement). Requires
 * typing the exact display name so it can't be triggered by a stray tap.
 */
export default function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me)
  const deleteAccount = useStore((s) => s.deleteAccount)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canDelete = me !== null && confirmText.trim().toLowerCase() === me.name.toLowerCase()

  async function onDelete() {
    if (!canDelete || busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteAccount() // wipes local data and reloads to the join screen
    } catch {
      setError('Could not delete your account — check the connection and try again.')
      setBusy(false)
    }
  }

  return (
    <div
      className="search-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
      onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}
    >
      <div className="confirm-panel" role="dialog" aria-label="Delete account">
        <h3>Delete your account?</h3>
        <p>
          This permanently removes <strong>{me?.name}</strong> from this crew server: your sign-in,
          your read state and your direct messages. Messages you posted in channels stay but are no
          longer shown as yours. This can’t be undone.
        </p>
        <label className="confirm-field">
          Type your name (<strong>{me?.name}</strong>) to confirm
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>
        {error && <div className="join-error">{error}</div>}
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="confirm-delete"
            onClick={() => void onDelete()}
            disabled={!canDelete || busy}
          >
            {busy ? 'Deleting…' : 'Delete account'}
          </button>
        </div>
      </div>
    </div>
  )
}
