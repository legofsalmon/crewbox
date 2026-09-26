import { useEffect, useState } from 'react'
import * as api from '../lib/api.ts'
import { adminError } from '../lib/adminerror.ts'

/** What each module's documents are called, for a row that has lost its title. */
const KINDS: Record<string, string> = {
  patch: 'Patch sheet',
  lighting: 'Lighting plot',
  video: 'Screen map',
}

const day = (at: number) =>
  new Date(at).toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

/**
 * Deleted sheets, plots and screen maps, which the box keeps for a week.
 *
 * Anyone can delete one for everybody, and the wrong tap is usually found at
 * the next changeover. Restore puts it back on every phone. Delete now is for
 * the thing that really should be gone before the week is up.
 */
export default function BinSection({
  auth,
  onNote,
}: {
  auth: () => api.AdminAuth
  onNote: (note: string) => void
}) {
  const [docs, setDocs] = useState<api.BinnedDoc[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // Asked in the panel rather than by the browser: a wipe is final.
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .adminBin(auth())
      .then(({ docs: next }) => live && setDocs(next))
      .catch((err: unknown) => live && onNote(adminError(err, 'Could not read the bin')))
    return () => {
      live = false
    }
    // Read once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function act(action: 'restore' | 'delete', doc: api.BinnedDoc) {
    const name = doc.title || KINDS[doc.module] || 'Document'
    setBusy(doc.room)
    setConfirming(null)
    try {
      const { docs: next } = await api.adminBinAct(auth(), action, doc.room)
      setDocs(next)
      onNote(
        action === 'restore'
          ? `“${name}” is back for everyone.`
          : `“${name}” is deleted from the box for good.`
      )
    } catch (err) {
      onNote(adminError(err, action === 'restore' ? 'Could not restore it' : 'Could not delete it'))
    } finally {
      setBusy(null)
    }
  }

  if (docs === null) return <p className="admin-hint">Reading the bin…</p>
  return (
    <>
      <p className="admin-hint">
        Deleted patch sheets, lighting plots and screen maps stay here for 7 days, then the box
        wipes them. Restoring one puts it back for everyone.
      </p>
      {docs.length === 0 ? (
        <p className="admin-muted admin-bin-empty">Nothing deleted this week.</p>
      ) : (
        <ul>
          {docs.map((doc) => (
            <li key={doc.room} className="admin-row admin-bin-row">
              <div className="admin-bin-what">
                <span className="admin-row-name">
                  {doc.title || `Untitled ${(KINDS[doc.module] ?? 'document').toLowerCase()}`}
                </span>
                <span className="admin-muted">
                  {KINDS[doc.module] ?? doc.module} · deleted {day(doc.deletedAt)} · wiped{' '}
                  {day(doc.purgesAt)}
                </span>
              </div>
              {confirming === doc.room ? (
                <>
                  <button
                    className="admin-btn danger confirm"
                    disabled={busy !== null}
                    onClick={() => void act('delete', doc)}
                  >
                    Delete for good
                  </button>
                  <button className="admin-btn" onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="admin-btn admin-btn-primary"
                    disabled={busy !== null}
                    onClick={() => void act('restore', doc)}
                  >
                    {busy === doc.room ? 'Restoring…' : 'Restore'}
                  </button>
                  <button
                    className="admin-btn"
                    disabled={busy !== null}
                    onClick={() => setConfirming(doc.room)}
                  >
                    Delete now
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
