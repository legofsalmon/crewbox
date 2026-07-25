import { useMemo, useState, type FormEvent } from 'react'
import { channelLabel, unreadCount, useStore } from '../../store.ts'

/**
 * Chat's sidebar sections — Channels and Direct messages — rendered by the
 * shell inside its nav. Extracted verbatim from the pre-module Sidebar.
 */
export default function ChatSidebar() {
  const me = useStore((s) => s.me)
  const users = useStore((s) => s.users)
  const channels = useStore((s) => s.channels)
  const online = useStore((s) => s.online)
  const remoteUsers = useStore((s) => s.remoteUsers)
  const readState = useStore((s) => s.readState)
  const mentionSeqs = useStore((s) => s.mentionSeqs)
  const activeChannelId = useStore((s) => s.activeChannelId)
  const activeModuleId = useStore((s) => s.activeModuleId)
  const setActiveChannel = useStore((s) => s.setActiveChannel)
  const openDm = useStore((s) => s.openDm)
  const createChannel = useStore((s) => s.createChannel)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  // A channel row is highlighted only while chat owns the main pane.
  const chatVisible = activeModuleId === null

  const publicChannels = useMemo(
    () =>
      Object.values(channels)
        .filter((c) => c.kind === 'public' && !c.retired)
        .sort((a, b) => a.createdAt - b.createdAt),
    [channels]
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
        .sort(
          (a, b) =>
            Number(online[b.id] ?? false) - Number(online[a.id] ?? false) ||
            a.name.localeCompare(b.name)
        ),
    [users, me, online]
  )

  function submitChannel(e: FormEvent) {
    e.preventDefault()
    const name = newName.trim().toLowerCase().replace(/\s+/g, '-')
    if (name) createChannel(name, '')
    setNewName('')
    setCreating(false)
  }

  return (
    <>
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
                className={`row ${chatVisible && channel.id === activeChannelId ? 'active' : ''} ${unread ? 'has-unread' : ''}`}
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
                className={`row ${chatVisible && dmId && dmId === activeChannelId ? 'active' : ''} ${unread ? 'has-unread' : ''}`}
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
                {unread > 0 && (
                  <span className="badge badge-mention">{unread > 99 ? '99+' : unread}</span>
                )}
              </button>
            </li>
          )
        })}
        {others.length === 0 && <li className="muted-note">No one else has joined yet</li>}
      </ul>
    </>
  )
}
