import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Channel, User } from '@crewbox/shared'
import { useStore } from '../store.ts'
import * as api from '../lib/api.ts'

const PIN_RE = /^\d{4,8}$/

/**
 * Session plus unlock. Read from the store rather than passed down, because
 * every row in this panel needs it and threading it through would be noise.
 * The admin token is only ever non-null while this component is mounted —
 * App.tsx renders the unlock screen instead when it isn't.
 */
function auth(): api.AdminAuth {
  return {
    token: localStorage.getItem('crewbox:token') ?? '',
    adminToken: useStore.getState().adminToken ?? '',
  }
}

export default function AdminPanel() {
  const setAdminOpen = useStore((s) => s.setAdminOpen)
  const lockAdmin = useStore((s) => s.lockAdmin)
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
      const blob = await api.adminExport(auth())
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
          {/* Closing the panel leaves it unlocked for the rest of the session,
              which is what makes it usable during a shift. Lock is the way to
              end that deliberately — before handing the phone to someone. */}
          <button className="admin-btn" onClick={lockAdmin}>
            Lock
          </button>
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
            <h3 className="admin-section-title">This box</h3>
            <ServerSection onNote={setNote} />
          </section>
          <section>
            <h3 className="admin-section-title">This network</h3>
            <p className="admin-hint">
              What the box has been plugged into. No internet is normal on site — nothing here needs
              it.
            </p>
            <Environment onNote={setNote} />
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

/** Enabled modules from live config (set via CREWBOX_MODULES on the box). */
function ModulesList() {
  const configModules = useStore((s) => s.config.modules)
  return (
    <>
      {configModules.join(', ')} <span className="admin-muted">(set via CREWBOX_MODULES)</span>
    </>
  )
}

const STATE_LABEL: Record<api.EnvState, string> = {
  ok: 'Working',
  limited: 'Limited',
  off: 'Off',
  // Not "Unknown" or "Warning": this state means there is nothing to fix,
  // and the label is read aloud by screen readers.
  info: 'For information',
}

const STATE_DOT: Record<api.EnvState, string> = {
  ok: '●',
  limited: '◐',
  off: '○',
  info: '·',
}

/**
 * Rows for both panels: what this box can do (readiness) and what it has been
 * plugged into (environment). One component because they are the same idea at
 * two scopes, and an admin should not have to learn two vocabularies.
 */
function Readiness({ checks }: { checks: (api.ReadinessCheck | api.EnvCheck)[] }) {
  return (
    <ul className="readiness">
      {checks.map((check) => (
        <li key={check.id} className={`readiness-row readiness-${check.state}`}>
          <span className="readiness-state" aria-label={STATE_LABEL[check.state]}>
            {STATE_DOT[check.state]}
          </span>
          <div className="readiness-body">
            <span className="readiness-label">{check.label}</span>
            <span className="readiness-detail">{check.detail}</span>
            {check.fix && <span className="readiness-fix">{check.fix}</span>}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** How long ago the environment was probed, for the "checked" line. */
function ago(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/**
 * The network around the box, as opposed to the box itself.
 *
 * Probed rather than rendered live: finding out there is no uplink is done by
 * waiting for a timeout, and an admin panel that stalls on that is worse than
 * one showing a result from a minute ago. Refresh is a button because the
 * answer only changes when someone changes the site.
 */
function Environment({ onNote }: { onNote: (note: string) => void }) {
  const [report, setReport] = useState<api.EnvironmentReport | null>(null)
  const [busy, setBusy] = useState(false)

  const load = (refresh: boolean) => {
    setBusy(true)
    api
      .adminGetEnvironment(auth(), refresh)
      .then(setReport)
      .catch((err) => onNote(err instanceof api.ApiError ? err.message : 'Could not check'))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    let live = true
    api
      .adminGetEnvironment(auth())
      .then((r) => live && setReport(r))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  async function downloadDns() {
    try {
      const blob = await api.adminDnsConfig(auth())
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'crewbox-dns.conf'
      a.click()
      URL.revokeObjectURL(url)
      onNote('DNS config downloaded — put it on the venue router')
    } catch (err) {
      onNote(err instanceof api.ApiError ? err.message : 'Could not build the DNS config')
    }
  }

  const pending = !report || report.pending
  const needsDns = report?.checks.some((c) => c.id === 'hostname' && c.state !== 'ok') ?? false
  return (
    <>
      {pending ? (
        <p className="admin-hint">Checking the network around this box…</p>
      ) : (
        <Readiness checks={report.checks} />
      )}
      <div className="admin-export">
        <button className="admin-btn" disabled={busy} onClick={() => load(true)}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
        {/* Only offered when the name is actually wrong — a download button
            for a problem you don't have is just clutter. */}
        {needsDns && (
          <button className="admin-btn" onClick={() => void downloadDns()}>
            Download DNS config
          </button>
        )}
        {!pending && <span className="admin-muted">Checked {ago(report.probedAt)}</span>}
      </div>
    </>
  )
}

/** One save-on-submit text setting. Three of these, so it's a component. */
function SettingField({
  id,
  label,
  value,
  saved,
  placeholder,
  minLength,
  saving,
  onChange,
  onSave,
}: {
  id: string
  label: string
  value: string
  /** What the server currently holds — Save is off until they differ. */
  saved: string | undefined
  placeholder: string
  minLength?: number
  saving: boolean
  onChange: (value: string) => void
  onSave: (e: FormEvent) => void
}) {
  const tooShort = minLength !== undefined && value.trim().length < minLength
  return (
    <form className="admin-setting" onSubmit={onSave}>
      <label htmlFor={id}>{label}</label>
      <div className="admin-setting-row">
        <input
          id={id}
          value={value}
          minLength={minLength}
          maxLength={64}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          className="admin-btn"
          disabled={saving || saved === undefined || tooShort || value === saved}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function ServerSection({ onNote }: { onNote: (note: string) => void }) {
  const [data, setData] = useState<api.AdminSettings | null>(null)
  const [eventName, setEventName] = useState('')
  const [ssid, setSsid] = useState('')
  const [pin, setPin] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    api
      .adminGetSettings(auth())
      .then((d) => {
        if (!live) return
        setData(d)
        setEventName(d.settings.eventName)
        setSsid(d.settings.wifiSsid)
        setPin(d.serverInfo.eventPin)
      })
      .catch((err) => onNote(err instanceof api.ApiError ? err.message : 'Could not load settings'))
    return () => {
      live = false
    }
  }, [onNote])

  /** Patch one setting, then refresh local state from what the server kept. */
  function save(
    patch: Parameters<typeof api.adminUpdateSettings>[1],
    note: string
  ): (e: FormEvent) => void {
    return (e) => {
      e.preventDefault()
      setSaving(true)
      void api
        .adminUpdateSettings(auth(), patch)
        .then(({ settings }) => {
          setEventName(settings.eventName)
          setSsid(settings.wifiSsid)
          setPin(settings.eventPin)
          setData((d) =>
            d
              ? {
                  ...d,
                  settings: { eventName: settings.eventName, wifiSsid: settings.wifiSsid },
                  serverInfo: { ...d.serverInfo, eventPin: settings.eventPin },
                }
              : d
          )
          onNote(note)
        })
        .catch((err) => onNote(err instanceof api.ApiError ? err.message : 'Save failed'))
        .finally(() => setSaving(false))
    }
  }

  const info = data?.serverInfo
  return (
    <>
      {data && <Readiness checks={data.readiness} />}
      <SettingField
        id="admin-event-name"
        label="Event name (shown to crew instead of “Crewbox”)"
        value={eventName}
        saved={data?.settings.eventName}
        placeholder="e.g. Ashton Court 2026"
        saving={saving}
        onChange={setEventName}
        onSave={save({ eventName: eventName.trim() }, 'Event name saved')}
      />
      <SettingField
        id="admin-event-pin"
        label="Event PIN (gates new joins; on the poster and /connect)"
        value={pin}
        saved={data?.serverInfo.eventPin}
        placeholder="e.g. 2468"
        minLength={4}
        saving={saving}
        onChange={setPin}
        onSave={save(
          { eventPin: pin.trim() },
          'Event PIN changed — update the poster or point crew at /connect'
        )}
      />
      <SettingField
        id="admin-ssid"
        label="Wi-Fi network (shown as join guidance)"
        value={ssid}
        saved={data?.settings.wifiSsid}
        placeholder="e.g. CrewNet"
        saving={saving}
        onChange={setSsid}
        onSave={save({ wifiSsid: ssid.trim() }, 'Wi-Fi network saved')}
      />
      {info && <AdminPasswordField fromEnv={info.adminPasswordFromEnv} onNote={onNote} />}
      {info && (
        <dl className="admin-info">
          <div>
            <dt>Version</dt>
            <dd>{info.version}</dd>
          </div>
          <div>
            <dt>Modules</dt>
            <dd>
              <ModulesList />
            </dd>
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

/**
 * Changing the admin password.
 *
 * Not a SettingField, because that one compares against the value the server
 * holds to decide whether Save does anything — and the whole point here is
 * that the server never sends this one back. Blank field, save when it's long
 * enough, blank again afterwards.
 */
function AdminPasswordField({
  fromEnv,
  onNote,
}: {
  fromEnv: boolean
  onNote: (note: string) => void
}) {
  const setAdminToken = useStore((s) => s.setAdminToken)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  if (fromEnv) {
    return (
      <div className="admin-setting">
        <label>Admin password</label>
        <p className="admin-muted">
          Set by <code>ADMIN_PASSWORD</code> in this box&rsquo;s service file, so it can&rsquo;t be
          changed from here. Change it there and restart.
        </p>
      </div>
    )
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    void api
      .adminUpdateSettings(auth(), { adminPassword: value })
      .then(({ adminToken }) => {
        // Every other unlocked device just lost its token; this one gets a
        // replacement so the person who made the change stays in.
        if (adminToken) setAdminToken(adminToken)
        setValue('')
        onNote('Admin password changed — any other device with the panel open is now locked')
      })
      .catch((err) => onNote(err instanceof api.ApiError ? err.message : 'Save failed'))
      .finally(() => setSaving(false))
  }

  return (
    <form className="admin-setting" onSubmit={submit}>
      <label htmlFor="admin-new-password">Admin password (opens this panel)</label>
      <div className="admin-setting-row">
        <input
          id="admin-new-password"
          type="password"
          value={value}
          disabled={saving}
          minLength={8}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="at least 8 characters"
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="admin-btn" type="submit" disabled={saving || value.trim().length < 8}>
          {saving ? 'Saving…' : 'Change'}
        </button>
      </div>
      <p className="admin-muted">
        Not the event PIN — this one is never shown to crew. Changing it locks every other device
        that had the panel open.
      </p>
    </form>
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
      await api.adminResetPin(auth(), user.id, pin)
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
      await api.adminUpdateChannel(auth(), channel.id, patch)
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
      await api.adminUpdateChannel(auth(), channel.id, { retired: true })
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
