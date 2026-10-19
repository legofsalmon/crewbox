import { useRef, useState, type KeyboardEvent } from 'react'
import { sessionToken, useStore, type SettingsTab } from '../store.ts'
import * as api from '../lib/api.ts'
import AdminPanel from './AdminPanel.tsx'
import AdminUnlock from './AdminUnlock.tsx'
import AlertSettings from './AlertSettings.tsx'
import FeedbackForm from './FeedbackForm.tsx'

const LABELS: Record<SettingsTab, string> = {
  general: 'General',
  alerts: 'Alerts',
  feedback: 'Feedback',
  admin: 'Admin',
}

/**
 * Settings, for everyone: what this person sets for themselves on one tab
 * each, and the box's own settings on the last, behind the admin password.
 *
 * It replaced a row of icons beside the sign-out button (the cog, the bell,
 * the theme) and two links under them (Alerts…, Send feedback…). Those were
 * five ways in to five places; this is one, and the cog that opened the admin
 * panel is still where it was, so somebody who knew the way still finds it.
 *
 * The Admin tab is always there, locked or not. A control nobody can find is
 * how a box loses its admin (AdminUnlock.tsx), so the password gates what is
 * in the tab rather than whether the tab is shown.
 */
export default function Settings() {
  const closeSettings = useStore((s) => s.closeSettings)
  const chosen = useStore((s) => s.settingsTab)
  const setTab = useStore((s) => s.setSettingsTab)
  const adminToken = useStore((s) => s.adminToken)
  const boxDecidesAlerts = useStore((s) => Boolean(s.config.alerts))
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({})

  // Alerts are kept on the box, and an older box keeps none: no tab for them.
  const tabs: SettingsTab[] = boxDecidesAlerts
    ? ['general', 'alerts', 'feedback', 'admin']
    : ['general', 'feedback', 'admin']
  const tab = tabs.includes(chosen) ? chosen : 'general'

  // One Tab stop for the row; the arrows move along it and choose
  // (design system: components.md, Tabs).
  function onTabKey(e: KeyboardEvent<HTMLDivElement>) {
    const at = tabs.indexOf(tab)
    const next =
      e.key === 'ArrowRight'
        ? tabs[(at + 1) % tabs.length]
        : e.key === 'ArrowLeft'
          ? tabs[(at - 1 + tabs.length) % tabs.length]
          : e.key === 'Home'
            ? tabs[0]
            : e.key === 'End'
              ? tabs[tabs.length - 1]
              : null
    if (!next) return
    e.preventDefault()
    setTab(next)
    tabRefs.current[next]?.focus()
  }

  return (
    <div
      className="admin-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSettings()
      }}
      onKeyDown={(e) => e.key === 'Escape' && closeSettings()}
    >
      <div className="admin-panel settings-panel" role="dialog" aria-label="Settings">
        <header className="admin-head">
          <h2>Settings</h2>
          <button className="icon-btn" aria-label="Close settings" onClick={closeSettings}>
            ✕
          </button>
        </header>
        <div className="settings-tabs" role="tablist" aria-label="Settings" onKeyDown={onTabKey}>
          {tabs.map((id) => (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[id] = el
              }}
              type="button"
              role="tab"
              id={`settings-tab-${id}`}
              aria-selected={tab === id}
              aria-controls="settings-tabpanel"
              tabIndex={tab === id ? 0 : -1}
              className="settings-tab"
              // Named as it reads, whichever line the state wraps onto.
              aria-label={id === 'admin' && !adminToken ? 'Admin, locked' : undefined}
              onClick={() => setTab(id)}
            >
              {LABELS[id]}
              {/* Says which way the tab is before it is opened, as the
                  word: a padlock alone is one more icon to learn. Beside
                  the name on a desk, under it on a phone. */}
              {id === 'admin' && !adminToken && (
                <span className="settings-tab-lock" aria-hidden>
                  <span className="settings-tab-dot"> · </span>locked
                </span>
              )}
            </button>
          ))}
        </div>
        <div
          className="settings-tabpanel"
          role="tabpanel"
          id="settings-tabpanel"
          aria-labelledby={`settings-tab-${tab}`}
        >
          {tab === 'general' && <General />}
          {tab === 'alerts' && <AlertSettings />}
          {tab === 'feedback' && <FeedbackForm />}
          {tab === 'admin' && (adminToken ? <AdminPanel /> : <AdminUnlock />)}
        </div>
      </div>
    </div>
  )
}

/** This device's own preferences: how it looks and whether it makes a sound. */
function General() {
  const theme = useStore((s) => s.theme)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const sounds = useStore((s) => s.sounds)
  const toggleSounds = useStore((s) => s.toggleSounds)

  return (
    <div className="admin-scroll settings-general">
      <section>
        <h3 className="admin-section-title" id="settings-theme">
          Theme
        </h3>
        {/* Light for daylight, dark for the tent. Both choices in view, so
            which one is on is read rather than inferred from an icon that
            shows the other. */}
        <div className="admin-row">
          <div className="settings-seg" role="group" aria-labelledby="settings-theme">
            {(['light', 'dark'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={theme === value}
                onClick={() => theme !== value && toggleTheme()}
              >
                {value === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>
      </section>
      <DepartmentPicker />
      <section>
        <h3 className="admin-section-title">Sound</h3>
        <label className="admin-row settings-switch">
          <input type="checkbox" role="switch" checked={sounds} onChange={toggleSounds} />
          <span>Alert sounds</span>
        </label>
        <p className="admin-hint settings-hint">
          The chime this app plays when an alert comes in, on this device only.
        </p>
      </section>
    </div>
  )
}

/**
 * Which department you are in: who an `@Lighting` reaches, and where you sit
 * in the crew list. Everybody's own to pick, since it opens nothing; an
 * admin can set it too. Not shown at all until the box has departments.
 */
function DepartmentPicker() {
  const me = useStore((s) => s.me)
  const departments = useStore((s) => s.departments)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sorted = Object.values(departments).sort((a, b) => a.name.localeCompare(b.name))
  if (!me || sorted.length === 0) return null
  const current = me.departmentId && departments[me.departmentId] ? me.departmentId : ''

  async function choose(departmentId: string) {
    setBusy(true)
    setError(null)
    try {
      await api.setMyDepartment(sessionToken() ?? '', departmentId || null)
    } catch (err) {
      setError(
        err instanceof api.ApiError
          ? err.message
          : 'Could not reach the box. Your department is as it was; try again once you’re back.'
      )
    } finally {
      setBusy(false)
    }
  }

  const name = current ? departments[current]!.name : null
  return (
    <section>
      <h3 className="admin-section-title" id="settings-department">
        Department
      </h3>
      <div className="admin-row settings-department">
        <select
          aria-labelledby="settings-department"
          value={current}
          disabled={busy}
          onChange={(e) => void choose(e.target.value)}
        >
          <option value="">None</option>
          {sorted.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <p className="admin-error settings-hint" role="alert">
          {error}
        </p>
      ) : (
        <p className="admin-hint settings-hint">
          {name
            ? `@${name} in any channel reaches you, as your own name does.`
            : 'Pick yours, and a message to @Lighting, say, reaches you if you’re in Lighting.'}
        </p>
      )}
    </section>
  )
}
