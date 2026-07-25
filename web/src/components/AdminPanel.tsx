import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Channel, User } from '@crewbox/shared'
import { useStore } from '../store.ts'
import * as api from '../lib/api.ts'

const PIN_RE = /^\d{4,8}$/

function token(): string {
  return localStorage.getItem('crewbox:token') ?? ''
}

export default function AdminPanel() {
  const setAdminOpen = useStore((s) => s.setAdminOpen)
  const users = useStore((s) => s.users)
  const online = useStore((s) => s.online)
  const channels = useStore((s) => s.channels)
  const me = useStore((s) => s.me)

  const [note, setNote] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const crew = useMemo(
    () =>
      Object.values(users).sort(
        (a, b) =>
          Number(online[b.id] ?? false) - Number(online[a.id] ?? false) ||
          a.name.localeCompare(b.name)
      ),
    [users, online]
  )
  const publicChannels = useMemo(
    () =>
      Object.values(channels)
        .filter((c) => c.kind === 'public' && !c.retired)
        .sort((a, b) => a.createdAt - b.createdAt),
    [channels]
  )

  async function downloadExport() {
    setExporting(true)
    try {
      const blob = await api.adminExport(token())
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `crewbox-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      setNote('Export downloaded')
    } catch (err) {
      setNote(err instanceof api.ApiError ? err.message : 'Export failed')
    } finally {
      setExporting(false)
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
      <div className="admin-panel" role="dialog" aria-label="Admin panel">
        <header className="admin-head">
          <h2>Admin</h2>
          <button
            className="icon-btn"
            aria-label="Close admin panel"
            onClick={() => setAdminOpen(false)}
          >
            ✕
          </button>
        </header>
        {note && <div className="admin-note">{note}</div>}
        <div className="admin-scroll">
          <section>
            <h3 className="admin-section-title">Crew</h3>
            <ul>
              {crew.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  online={!!online[user.id]}
                  isMe={user.id === me?.id}
                  onNote={setNote}
                />
              ))}
            </ul>
          </section>
          <section>
            <h3 className="admin-section-title">Channels</h3>
            <ul>
              {publicChannels.map((channel) => (
                <ChannelRow key={channel.id} channel={channel} onNote={setNote} />
              ))}
            </ul>
          </section>
          <section>
            <h3 className="admin-section-title">Server</h3>
            <ServerSection onNote={setNote} />
          </section>
          <section>
            <h3 className="admin-section-title">Export</h3>
            <p className="admin-hint">
              Download every user, channel and message as a JSON file for the post-event archive.
            </p>
            <div className="admin-export">
              <button
                className="admin-btn"
                disabled={exporting}
                onClick={() => void downloadExport()}
              >
                {exporting ? 'Preparing…' : 'Download chat logs'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function ServerSection({ onNote }: { onNote: (note: string) => void }) {
  const [data, setData] = useState<api.AdminSettings | null>(null)
  const [ssid, setSsid] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    api
      .adminGetSettings(token())
      .then((d) => {
        if (!live) return
        setData(d)
        setSsid(d.settings.wifiSsid)
      })
      .catch((err) => onNote(err instanceof api.ApiError ? err.message : 'Could not load settings'))
    return () => {
      live = false
    }
  }, [onNote])

  async function saveSsid(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const { settings } = await api.adminUpdateSettings(token(), { wifiSsid: ssid.trim() })
      setSsid(settings.wifiSsid)
      onNote('Wi-Fi network saved')
    } catch (err) {
      onNote(err instanceof api.ApiError ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const info = data?.serverInfo
  return (
    <>
      <form className="admin-setting" onSubmit={(e) => void saveSsid(e)}>
        <label htmlFor="admin-ssid">Wi-Fi network (shown as join guidance)</label>
        <div className="admin-setting-row">
          <input
            id="admin-ssid"
            value={ssid}
            maxLength={64}
            placeholder="e.g. CrewNet"
            onChange={(e) => setSsid(e.target.value)}
          />
          <button
            className="admin-btn"
            disabled={saving || !data || ssid === data.settings.wifiSsid}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
      {info && (
        <dl className="admin-info">
          <div>
            <dt>Event PIN</dt>
            <dd>
              {info.eventPin} <span className="admin-muted">(for posters · set via EVENT_PIN)</span>
            </dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{info.version}</dd>
          </div>
          <div>
            <dt>Uptime</dt>
            <dd>{formatUptime(info.uptimeSec)}</dd>
          </div>
          <div>
            <dt>Online</dt>
            <dd>
              {info.onlineUsers} crew · {info.connections} connections
            </dd>
          </div>
          <div>
            <dt>Voice</dt>
            <dd>{info.voiceEnabled ? 'Enabled' : 'Not configured'}</dd>
          </div>
        </dl>
      )}
    </>
  )
}

function UserRow({
  user,
  online,
  isMe,
  onNote,
}: {
  user: User
  online: boolean
  isMe: boolean
  onNote: (note: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!PIN_RE.test(pin)) return
    setBusy(true)
    try {
      await api.adminResetPin(token(), user.id, pin)
      onNote(`PIN reset for ${user.name}`)
      setEditing(false)
      setPin('')
    } catch (err) {
      onNote(err instanceof api.ApiError ? err.message : 'PIN reset failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="admin-row">
      <span className={`presence-dot ${online ? 'on' : ''}`} />
      <span className="admin-row-name">
        {user.name}
        {isMe && <span className="admin-muted"> (you)</span>}
      </span>
      {user.role === 'admin' && <span className="role-tag">admin</span>}
      <span className="admin-muted">{online ? 'online' : 'offline'}</span>
      {editing ? (
        <form className="admin-inline-form" onSubmit={(e) => void submit(e)}>
          <input
            autoFocus
            inputMode="numeric"
            maxLength={8}
            placeholder="New PIN"
            aria-label={`New PIN for ${user.name}`}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          />
          <button className="admin-btn" disabled={busy || !PIN_RE.test(pin)}>
            Save
          </button>
        </form>
      ) : (
        <button className="admin-btn" onClick={() => setEditing(true)}>
          Reset PIN
        </button>
      )}
    </li>
  )
}

function ChannelRow({ channel, onNote }: { channel: Channel; onNote: (note: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(channel.name)
  const [topic, setTopic] = useState(channel.topic)
  const [confirmRetire, setConfirmRetire] = useState(false)
  const [busy, setBusy] = useState(false)

  function startEditing() {
    setName(channel.name)
    setTopic(channel.topic)
    setConfirmRetire(false)
    setEditing(true)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const nextName = name.trim().toLowerCase().replace(/\s+/g, '-')
    const patch: { name?: string; topic?: string } = {}
    if (nextName && nextName !== channel.name) patch.name = nextName
    if (topic !== channel.topic) patch.topic = topic
    if (!Object.keys(patch).length) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await api.adminUpdateChannel(token(), channel.id, patch)
      onNote(`#${patch.name ?? channel.name} updated`)
      setEditing(false)
    } catch (err) {
      onNote(err instanceof api.ApiError ? err.message : 'Channel update failed')
    } finally {
      setBusy(false)
    }
  }

  async function retire() {
    if (!confirmRetire) {
      setConfirmRetire(true)
      return
    }
    setBusy(true)
    try {
      await api.adminUpdateChannel(token(), channel.id, { retired: true })
      onNote(`#${channel.name} retired`)
    } catch (err) {
      onNote(err instanceof api.ApiError ? err.message : 'Retire failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="admin-channel">
      <div className="admin-row">
        <span className="row-hash">#</span>
        <span className="admin-row-name">{channel.name}</span>
        {channel.topic && <span className="admin-muted admin-topic">{channel.topic}</span>}
        <button className="admin-btn" onClick={editing ? () => setEditing(false) : startEditing}>
          {editing ? 'Cancel' : 'Edit'}
        </button>
      </div>
      {editing && (
        <form className="admin-channel-form" onSubmit={(e) => void save(e)}>
          <input
            autoFocus
            value={name}
            maxLength={32}
            placeholder="channel-name"
            aria-label={`Rename #${channel.name}`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          />
          <input
            value={topic}
            maxLength={200}
            placeholder="Topic"
            aria-label={`Topic for #${channel.name}`}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          />
          <div className="admin-channel-actions">
            <button className="admin-btn" disabled={busy}>
              Save
            </button>
            {channel.name !== 'general' && (
              <button
                type="button"
                className={`admin-btn danger ${confirmRetire ? 'confirm' : ''}`}
                disabled={busy}
                onClick={() => void retire()}
              >
                {confirmRetire ? 'Really retire?' : 'Retire'}
              </button>
            )}
          </div>
        </form>
      )}
    </li>
  )
}
