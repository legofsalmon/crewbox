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
 * The box keeping the router's DNS entry for its name pointed at itself
 * (server/src/routerDns.ts).
 *
 * Off until ticked, and worded for the one case it fits: the crew's own
 * OpenWrt router, such as a GL.iNet. The password field is always blank —
 * the box never sends it back — and a save that leaves it blank keeps the
 * one already saved.
 */
export default function RouterDnsSection({
  auth,
  onNote,
}: {
  auth: () => api.AdminAuth
  onNote: (note: string) => void
}) {
  const [state, setState] = useState<api.RouterDns | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [host, setHost] = useState('')
  const [username, setUsername] = useState('root')
  const [password, setPassword] = useState('')
  const [forgetKey, setForgetKey] = useState(false)
  const [busy, setBusy] = useState<'save' | 'sync' | null>(null)

  const take = (next: api.RouterDns) => {
    setState(next)
    setEnabled(next.enabled)
    setHost(next.host)
    setUsername(next.username)
    setPassword('')
    setForgetKey(false)
  }

  useEffect(() => {
    let live = true
    api
      .adminRouterDns(auth())
      .then((next) => live && take(next))
      .catch((err: unknown) => live && onNote(adminError(err, 'Could not read the router setting')))
    return () => {
      live = false
    }
    // Read once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!state) return
    setBusy('save')
    try {
      const next = await api.adminSaveRouterDns(auth(), {
        enabled,
        host: host.trim(),
        port: state.port,
        username: username.trim() || 'root',
        ...(password ? { password } : {}),
        ...(forgetKey ? { forgetHostKey: true } : {}),
      })
      take(next)
      onNote(next.enabled ? next.status.message : 'The box will leave the router alone.')
    } catch (err) {
      onNote(adminError(err, 'Could not save the router setting'))
    } finally {
      setBusy(null)
    }
  }

  async function syncNow() {
    setBusy('sync')
    try {
      const next = await api.adminSyncRouterDns(auth())
      setState(next)
      onNote(next.status.message)
    } catch (err) {
      onNote(adminError(err, 'Could not update the router'))
    } finally {
      setBusy(null)
    }
  }

  if (!state) return null
  const { status } = state
  const needsPassword = enabled && !state.hasPassword && !password
  return (
    <form className="admin-setting" onSubmit={(e) => void save(e)}>
      <label className="admin-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Keep the router pointed at this box
      </label>
      <p className="admin-hint">
        For your own OpenWrt router, such as a GL.iNet. The box logs in to it over SSH and moves the
        DNS entry for its name whenever its own address changes, so phones and the admin link keep
        finding it. It needs the router’s admin password, kept on this box.
      </p>
      {enabled && (
        <>
          <label htmlFor="admin-router-host">Router address</label>
          <input
            id="admin-router-host"
            value={host}
            maxLength={253}
            placeholder={state.suggestedHost || '192.168.8.1'}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setHost(e.target.value)}
          />
          <label htmlFor="admin-router-user">Username</label>
          <input
            id="admin-router-user"
            value={username}
            maxLength={64}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setUsername(e.target.value)}
          />
          <label htmlFor="admin-router-password">Password</label>
          <input
            id="admin-router-password"
            type="password"
            value={password}
            maxLength={256}
            autoComplete="off"
            placeholder={
              state.hasPassword ? 'Saved; type to replace it' : 'The router’s admin password'
            }
            onChange={(e) => setPassword(e.target.value)}
          />
          {state.hostKey && (
            <label className="admin-check">
              <input
                type="checkbox"
                checked={forgetKey}
                onChange={(e) => setForgetKey(e.target.checked)}
              />
              Forget the router’s key (only after resetting or replacing the router)
            </label>
          )}
        </>
      )}
      <div className="admin-export">
        <button
          className="admin-btn"
          disabled={busy !== null || needsPassword || (enabled && !host.trim())}
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        {state.enabled && (
          <button
            type="button"
            className="admin-btn"
            disabled={busy !== null}
            onClick={() => void syncNow()}
          >
            {busy === 'sync' ? 'Updating…' : 'Update the router now'}
          </button>
        )}
      </div>
      {state.enabled && (
        <p className={status.state === 'failed' ? 'admin-error' : 'admin-status'} role="status">
          {status.message}
          {status.state === 'ok' && status.at ? ` Checked ${ago(status.at)}.` : ''}
        </p>
      )}
    </form>
  )
}
