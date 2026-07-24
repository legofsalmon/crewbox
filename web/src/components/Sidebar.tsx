import { useMemo, useState, type FormEvent } from 'react'
import { channelLabel, unreadCount, useStore } from '../store.ts'
import { classifyLatency } from '../lib/quality.ts'
import { APP_VERSION } from '../lib/pwa.ts'
import Avatar from './Avatar.tsx'

/** Stroke icon in the same style as the channel-header buttons — emoji
 * render differently on every platform, SVG doesn't. */
function Icon({ d, circle }: { d: string; circle?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {circle && <circle cx="12" cy="12" r="3" />}
      <path d={d} />
    </svg>
  )
}

const ICON_BELL = 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0'
const ICON_BELL_OFF =
  'M13.7 21a2 2 0 0 1-3.4 0M18.6 13A17.9 17.9 0 0 1 18 8a6 6 0 0 0-9.3-5M6.3 6.3C6.1 6.8 6 7.4 6 8c0 7-3 9-3 9h14M2 2l20 20'
const ICON_SUN =
  'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'
const ICON_MOON = 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'
const ICON_LOGOUT = 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'
const ICON_GEAR =
  'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'

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
  const remoteUsers = useStore((s) => s.remoteUsers)
  const readState = useStore((s) => s.readState)
  const mentionSeqs = useStore((s) => s.mentionSeqs)
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
            // An unseen @mention outranks plain unread — different signal.
            const mentioned = (mentionSeqs[channel.id] ?? 0) > (readState[channel.id] ?? 0)
            return (
              <li key={channel.id}>
                <button
                  className={`row ${channel.id === activeChannelId ? 'active' : ''} ${unread ? 'has-unread' : ''}`}
                  aria-label={`#${channelLabel(channel, users, me?.id)}${unread ? `, ${unread} unread` : ''}${mentioned ? ', mentions you' : ''}`}
                  onClick={() => setActiveChannel(channel.id)}
                >
                  <span className="row-hash">#</span>
                  <span className="row-name">{channelLabel(channel, users, me?.id)}</span>
                  {unread > 0 && (
                    <span className={`badge ${mentioned ? 'badge-mention' : ''}`}>
                      {mentioned ? '@' : ''}
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
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
                  aria-label={`Message ${user.name}${online[user.id] ? (remoteUsers[user.id] ? ' (online remotely)' : ' (online)') : ''}${unread ? `, ${unread} unread` : ''}`}
                  onClick={() => openDm(user.id)}
                >
                  <span className={`presence-dot ${online[user.id] ? 'on' : ''}`} />
                  <span className="row-name">{user.name}</span>
                  {online[user.id] && remoteUsers[user.id] && (
                    <span className="office-badge" title="Joining from off-site">
                      office
                    </span>
                  )}
                  {/* A DM unread is always personal — mention styling. */}
                  {unread > 0 && <span className="badge badge-mention">{unread > 99 ? '99+' : unread}</span>}
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
                ? `Online${latencyMs !== null ? ` · ${latencyMs} ms` : ''}`
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
              <Icon d={ICON_GEAR} circle />
            </button>
          )}
          <button
            className="icon-btn"
            title={sounds ? 'Mute alert sounds' : 'Unmute alert sounds'}
            aria-label={sounds ? 'Mute alert sounds' : 'Unmute alert sounds'}
            onClick={toggleSounds}
          >
            <Icon d={sounds ? ICON_BELL : ICON_BELL_OFF} />
          </button>
          <button
            className="icon-btn"
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={toggleTheme}
          >
            <Icon d={theme === 'dark' ? ICON_SUN : ICON_MOON} />
          </button>
          <button className="icon-btn" title="Sign out" aria-label="Sign out" onClick={() => void logout()}>
            <Icon d={ICON_LOGOUT} />
          </button>
        </div>
      )}
      <div className="app-version" title={`Inter ${APP_VERSION}`}>
        v{APP_VERSION}
      </div>
    </aside>
  )
}
