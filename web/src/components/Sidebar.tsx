import { useState } from 'react'
import { useStore } from '../store.ts'
import { classifyLatency } from '../lib/quality.ts'
import { APP_VERSION } from '../lib/pwa.ts'
import { allModules } from '../shell/registry.ts'
import { enabledModules } from '../shell/modules.ts'
import Avatar from './Avatar.tsx'
import DeleteAccountDialog from './DeleteAccountDialog.tsx'

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

/**
 * The shell sidebar: brand header, one section per enabled module (chat's
 * channels and DMs first), and the identity/footer row. Module sections come
 * from the registry — this component knows nothing about their contents.
 */
export default function Sidebar() {
  const me = useStore((s) => s.me)
  const connection = useStore((s) => s.connection)
  const logout = useStore((s) => s.logout)
  const theme = useStore((s) => s.theme)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const sounds = useStore((s) => s.sounds)
  const toggleSounds = useStore((s) => s.toggleSounds)
  const setAdminOpen = useStore((s) => s.setAdminOpen)
  const latencyMs = useStore((s) => s.latencyMs)
  const configModules = useStore((s) => s.config.modules)

  const [deleteOpen, setDeleteOpen] = useState(false)

  const sections = enabledModules(allModules, configModules)

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span
          className={`conn-dot conn-dot-${connDotClass(connection, latencyMs)}`}
          title={connection}
        />
        <h1>Crewbox</h1>
      </div>

      <nav className="sidebar-scroll">
        {sections.map((module) => (
          <module.SidebarSection key={module.id} />
        ))}
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
          <button
            className="icon-btn"
            title="Sign out"
            aria-label="Sign out"
            onClick={() => void logout()}
          >
            <Icon d={ICON_LOGOUT} />
          </button>
        </div>
      )}
      <div className="sidebar-footer-links">
        {me && (
          <button className="delete-account-link" onClick={() => setDeleteOpen(true)}>
            Delete account
          </button>
        )}
        <span className="app-version" title={`Crewbox ${APP_VERSION}`}>
          v{APP_VERSION}
        </span>
      </div>
      {deleteOpen && <DeleteAccountDialog onClose={() => setDeleteOpen(false)} />}
    </aside>
  )
}
