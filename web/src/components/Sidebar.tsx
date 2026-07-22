import { useMemo, useState, type FormEvent } from 'react'
import { channelLabel, unreadCount, useStore } from '../store.ts'
import { classifyLatency } from '../lib/quality.ts'
import Avatar from './Avatar.tsx'

/** Dot color: connection state first, then latency quality while online. */
function connDotClass(connection: string, latencyMs: number | null): string {
  if (connection !== 'online') return connection
  if (latencyMs === null) return 'online'
  const cls = classifyLatency(latencyMs)
  return cls === 'good' ? 'online' : cls
}

export default function Sidebar() {
  const me = useStore((s) => s.me)
  const users = useStore((s) => s.users)
  const channels = useStore((s) => s.channels)
  const online = useStore((s) => s.online)
  const readState = useStore((s) => s.readState)
  const activeChannelId = useStore((s) => s.activeChannelId)
  const setActiveChannel = useStore((s) => s.setActiveChannel)
  const openDm = useStore((s) => s.openDm)
  const createChannel = useStore((s) => s.createChannel)
  const connection = useStore((s) => s.connection)
  const logout = useStore((s) => s.logout)
  const theme = useStore((s) => s.theme)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const sounds = useStore((s) => s.sounds)
  const toggleSounds = useStore((s) => s.toggleSounds)
  const setAdminOpen = useStore((s) => s.setAdminOpen)
  const latencyMs = useStore((s) => s.latencyMs)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const publicChannels = useMemo(
    () =>
      Object.values(channels)
        .filter((c) => c.kind === 'public' && !c.retired)
        .sort((a, b) => a.createdAt - b.createdAt),
    [channels],
  )
  const dmByOther = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of Object.values(channels)) {
      if (c.kind !== 'dm') continue
      const other = c.memberIds?.find((id) => id !== me?.id) ?? me?.id
      if (other) map.set(other, c.id)
    }
    return map
  }, [channels, me])
  const others = useMemo(
    () =>
      Object.values(users)
        .filter((u) => u.id !== me?.id)
        .sort((a, b) => Number(online[b.id] ?? false) - Number(online[a.id] ?? false) || a.name.localeCompare(b.name)),
    [users, me, online],
  )

  function submitChannel(e: FormEvent) {
    e.preventDefault()
    const name = newName.trim().toLowerCase().replace(/\s+/g, '-')
    if (name) createChannel(name, '')
    setNewName('')
    setCreating(false)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className={`conn-dot conn-dot-${connDotClass(connection, latencyMs)}`} title={connection} />
        <h1>Inter</h1>
      </div>

      <nav className="sidebar-scroll">
        <div className="section-head">
          <span>Channels</span>
          <button
            className="icon-btn"
            aria-label="New channel"
            onClick={() => setCreating((v) => !v)}
          >
            +
          </button>
        </div>
        {creating && (
          <form className="new-channel" onSubmit={submitChannel}>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="channel-name"
              maxLength={32}
              onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
            />
          </form>
        )}
        <ul>
          {publicChannels.map((channel) => {
            const unread = unreadCount(channel, readState)
            return (
              <li key={channel.id}>
                <button
                  className={`row ${channel.id === activeChannelId ? 'active' : ''} ${unread ? 'has-unread' : ''}`}
                  aria-label={`#${channelLabel(channel, users, me?.id)}${unread ? `, ${unread} unread` : ''}`}
                  onClick={() => setActiveChannel(channel.id)}
                >
                  <span className="row-hash">#</span>
                  <span className="row-name">{channelLabel(channel, users, me?.id)}</span>
                  {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
                </button>
              </li>
            )
          })}
        </ul>

        <div className="section-head">
          <span>Direct messages</span>
        </div>
        <ul>
          {others.map((user) => {
            const dmId = dmByOther.get(user.id)
            const channel = dmId ? channels[dmId] : undefined
            const unread = channel ? unreadCount(channel, readState) : 0
            return (
              <li key={user.id}>
                <button
                  className={`row ${dmId && dmId === activeChannelId ? 'active' : ''} ${unread ? 'has-unread' : ''}`}
                  aria-label={`Message ${user.name}${online[user.id] ? ' (online)' : ''}${unread ? `, ${unread} unread` : ''}`}
                  onClick={() => openDm(user.id)}
                >
                  <span className={`presence-dot ${online[user.id] ? 'on' : ''}`} />
                  <span className="row-name">{user.name}</span>
                  {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
                </button>
              </li>
            )
          })}
          {others.length === 0 && <li className="muted-note">No one else has joined yet</li>}
        </ul>
      </nav>

      {me && (
        <div className="sidebar-me">
          <Avatar name={me.name} id={me.id} size={32} />
          <div className="me-info">
            <span className="me-name">{me.name}</span>
            <span className="me-status">
              {connection === 'online'
                ? `Connected${latencyMs !== null ? ` · ${latencyMs} ms` : ''}`
                : connection === 'connecting'
                  ? 'Connecting…'
                  : 'Offline'}
            </span>
          </div>
          {me.role === 'admin' && (
            <button
              className="icon-btn"
              title="Admin panel"
              aria-label="Admin panel"
              onClick={() => setAdminOpen(true)}
            >
              ⚙︎
            </button>
          )}
          <button
            className="icon-btn"
            title={sounds ? 'Mute alert sounds' : 'Unmute alert sounds'}
            aria-label={sounds ? 'Mute alert sounds' : 'Unmute alert sounds'}
            onClick={toggleSounds}
          >
            {sounds ? '🔔' : '🔕'}
          </button>
          <button
            className="icon-btn"
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button className="icon-btn" title="Sign out" aria-label="Sign out" onClick={() => void logout()}>
            ⎋
          </button>
        </div>
      )}
    </aside>
  )
}
