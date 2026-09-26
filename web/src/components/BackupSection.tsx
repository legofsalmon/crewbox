import { useEffect, useState, type FormEvent } from 'react'
import * as api from '../lib/api.ts'
import { adminError } from '../lib/adminerror.ts'

const ago = (at: number): string => {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/**
 * The box's own backups: where they go, the last one, and one now.
 *
 * The box takes one every few hours by itself. What it can't do is know
 * where a USB stick is, and a backup on the disk the box runs from dies with
 * it, so the folder is the one thing an admin has to give it.
 */
export default function BackupSection({
  auth,
  onNote,
}: {
  auth: () => api.AdminAuth
  onNote: (note: string) => void
}) {
  const [state, setState] = useState<api.BackupState | null>(null)
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState<'save' | 'run' | null>(null)

  useEffect(() => {
    let live = true
    api
      .adminBackup(auth())
      .then(({ backup }) => {
        if (!live) return
        setState(backup)
        setDir(backup.chosen ? backup.dir : '')
      })
      .catch(
        (err: unknown) => live && onNote(adminError(err, 'Could not read the backup settings'))
      )
    return () => {
      live = false
    }
    // Read once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy('save')
    try {
      const { backup } = await api.adminSetBackupDir(auth(), dir.trim())
      setState(backup)
      onNote(`Backups now go to ${backup.dir}.`)
    } catch (err) {
      onNote(adminError(err, 'Could not change the backup folder'))
    } finally {
      setBusy(null)
    }
  }

  async function runNow() {
    setBusy('run')
    try {
      const { backup } = await api.adminBackUpNow(auth())
      setState(backup)
      onNote(`Backed up to ${backup.last?.dest ?? backup.dir}.`)
    } catch (err) {
      onNote(adminError(err, 'Could not back up'))
      api
        .adminBackup(auth())
        .then(({ backup }) => setState(backup))
        .catch(() => {})
    } finally {
      setBusy(null)
    }
  }

  if (!state) return <p className="admin-hint">Reading the backup settings…</p>
  const saved = state.chosen ? state.dir : ''
  return (
    <>
      <p className="admin-hint">
        {state.everyHours > 0
          ? `The box backs itself up every ${state.everyHours} hours: the database, uploads, the certificate and the Android app.`
          : 'This box takes no backups on a timer. Back up now still works.'}{' '}
        {state.last
          ? `Last one ${ago(state.last.at)}${state.last.dest ? `, to ${state.last.dest}` : ''}.`
          : 'None yet.'}
      </p>
      {state.error && <p className="admin-error">The last try failed: {state.error}.</p>}
      {state.sameDisk && (
        <p className="admin-status">
          {state.dir} is on the same disk as the box’s data, so a dead disk takes the backups with
          it. Plug in a USB stick and put its folder below.
        </p>
      )}
      <form className="admin-setting" onSubmit={(e) => void save(e)}>
        <label htmlFor="admin-backup-dir">Backup folder</label>
        <div className="admin-setting-row">
          <input
            id="admin-backup-dir"
            value={dir}
            maxLength={1024}
            placeholder={state.defaultDir}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setDir(e.target.value)}
          />
          <button className="admin-btn" disabled={busy !== null || dir.trim() === saved}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
      <div className="admin-export">
        <button
          className="admin-btn"
          disabled={busy !== null || state.running}
          onClick={() => void runNow()}
        >
          {busy === 'run' || state.running ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
    </>
  )
}
