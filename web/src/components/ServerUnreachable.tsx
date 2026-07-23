import { useStore } from '../store.ts'
import { APP_VERSION } from '../lib/pwa.ts'
import { effectiveSsid } from '../lib/settings.ts'

/** Shown when the app can't reach the server on a cold load with no cache. */
export default function ServerUnreachable() {
  const connection = useStore((s) => s.connection)
  const retryConnection = useStore((s) => s.retryConnection)
  const wifiSsid = useStore((s) => effectiveSsid(s.config.wifiSsid))
  const retrying = connection === 'connecting'

  return (
    <div className="center-screen">
      <div className="center-card">
        <svg viewBox="0 0 48 48" className="join-logo center-logo" aria-hidden>
          <path d="M10 30a14 14 0 0 1 28 0" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <path d="M17 30a7 7 0 0 1 14 0" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <circle cx="24" cy="33" r="3.5" fill="currentColor" />
          <line x1="8" y1="40" x2="40" y2="8" stroke="var(--danger)" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <h1>Can't reach the crew server</h1>
        <p>
          Make sure you're connected to {wifiSsid ? <strong>{wifiSsid}</strong> : 'the crew Wi-Fi'}.
          If the server is restarting, this will clear on its own.
        </p>
        <button className="center-retry" onClick={retryConnection} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry now'}
        </button>
        <div className="center-meta">
          Trying {location.host} · retrying automatically
        </div>
        <div className="center-version">v{APP_VERSION}</div>
      </div>
    </div>
  )
}

/** Calm placeholder during the very first connect (no cache yet). */
export function Connecting() {
  return (
    <div className="center-screen">
      <div className="center-card">
        <span className="center-spinner" aria-hidden />
        <p>Connecting to the crew server…</p>
      </div>
    </div>
  )
}
