import { useStore } from '../store.ts'
import { elsewhereCopy } from '../lib/connscreen.ts'
import { APP_VERSION } from '../lib/pwa.ts'
import { effectiveSsid } from '../lib/settings.ts'
import { serverLabel } from '../lib/server.ts'
import { useBoxesOffered } from '../lib/useBoxesOffered.ts'

/** Shown when the app can't reach the server on a cold load with no cache. */
export default function ServerUnreachable() {
  const connection = useStore((s) => s.connection)
  const retryConnection = useStore((s) => s.retryConnection)
  const wifiSsid = useStore((s) => effectiveSsid(s.config.wifiSsid))
  const elsewhere = useStore((s) => s.elsewhere)
  const eventName = useStore((s) => s.config.eventName)
  const switchEvent = useStore((s) => s.switchEvent)
  const setBoxesOpen = useStore((s) => s.setBoxesOpen)
  const boxesOffered = useBoxesOffered()
  const retrying = connection === 'connecting'
  // Retry was the whole of this screen, and a box with a new address never
  // answers it: the Boxes screen is where the app can be told where it went.
  const boxes = boxesOffered && (
    <button className="center-other" onClick={() => setBoxesOpen(true)}>
      Your boxes
    </button>
  )

  if (elsewhere) {
    // Reached, and running another event: not a box that is missing.
    return (
      <div className="center-screen">
        <div className="center-card">
          <h1>The box has changed</h1>
          <p>
            {elsewhereCopy({ address: serverLabel(), open: eventName, here: elsewhere.name })}{' '}
            Anything you had from before stays on this device, and none of it goes to the new box.
          </p>
          <button className="center-retry" onClick={() => switchEvent(elsewhere.id)}>
            Open it
          </button>
          {boxes}
          <div className="center-version">v{APP_VERSION}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="center-screen">
      <div className="center-card">
        <svg viewBox="0 0 48 48" className="join-logo center-logo" aria-hidden>
          <path
            d="M10 30a14 14 0 0 1 28 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="M17 30a7 7 0 0 1 14 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <circle cx="24" cy="33" r="3.5" fill="currentColor" />
          <line
            x1="8"
            y1="40"
            x2="40"
            y2="8"
            stroke="var(--danger)"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
        <h1>Can't reach the crew server</h1>
        <p>
          Make sure you're connected to {wifiSsid ? <strong>{wifiSsid}</strong> : 'the crew Wi-Fi'}.
          If the server is restarting, this will clear on its own.
        </p>
        <button className="center-retry" onClick={retryConnection} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry now'}
        </button>
        {boxes}
        <div className="center-meta">Trying {serverLabel()} · retrying automatically</div>
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
