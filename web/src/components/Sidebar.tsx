import { useState } from 'react'
import { useStore } from '../store.ts'
import { classifyLatency } from '../lib/quality.ts'
import { APP_VERSION } from '../lib/pwa.ts'
import { displayName } from '../lib/settings.ts'
import { allModules } from '../shell/registry.ts'
import { enabledModules } from '../shell/modules.ts'
import Avatar from './Avatar.tsx'
import { useBoxesOffered } from '../lib/useBoxesOffered.ts'
import DeleteAccountDialog from './DeleteAccountDialog.tsx'
import PanicButton from './PanicButton.tsx'

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
  const openSettings = useStore((s) => s.openSettings)
  const latencyMs = useStore((s) => s.latencyMs)
  const configModules = useStore((s) => s.config.modules)
  const eventName = useStore((s) => displayName(s.config.eventName))
  const setBoxesOpen = useStore((s) => s.setBoxesOpen)
  const boxesOffered = useBoxesOffered()
  const unlicensed = useStore((s) => s.config.unlicensed === true)
  // A box that knows cue lights knows the panic button; an older one sends
  // neither, and a button that can only fail is worse than none.
  const hasPanic = useStore((s) => s.cues !== null)

  const [deleteOpen, setDeleteOpen] = useState(false)

  const sections = enabledModules(allModules, configModules)

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span
          className={`conn-dot conn-dot-${connDotClass(connection, latencyMs)}`}
          title={connection}
        />
        <h1>{eventName}</h1>
        {boxesOffered && (
          <button className="sidebar-boxes" onClick={() => setBoxesOpen(true)}>
            Your boxes
          </button>
        )}
      </div>

      <nav className="sidebar-scroll">
        {sections.map((module) => (
          <module.SidebarSection key={module.id} />
        ))}
      </nav>

      {/* Always in the same place, under the modules and above you, so it
          is found without looking for it. Only on a box that has it. */}
      {me && hasPanic && <PanicButton />}
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
          {/* Settings, for everyone: theme, alert sounds, alerts, feedback,
              and the Admin tab behind the box's password. Where the admin
              cog always was, so the way in has not moved. */}
          <button
            className="icon-btn"
            title="Settings"
            aria-label="Settings"
            onClick={() => openSettings()}
          >
            <Icon d={ICON_GEAR} circle />
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
        {/* The box's licence, not this phone's, and only ever a mark: nothing
            a crew member does is blocked or slowed by it. Sized with the
            version beside it so it is there without being in the way. */}
        {unlicensed && <span className="unlicensed-mark">Unlicensed</span>}
        {/* The version opens the licences of everything Crewbox ships that
            it did not write (scripts/third-party-notices.mjs). */}
        <a
          className="app-version"
          href="/third-party-notices.txt"
          target="_blank"
          rel="noreferrer"
          title={`Crewbox ${APP_VERSION} — open-source licences`}
        >
          v{APP_VERSION}
        </a>
      </div>
      {deleteOpen && <DeleteAccountDialog onClose={() => setDeleteOpen(false)} />}
    </aside>
  )
}
