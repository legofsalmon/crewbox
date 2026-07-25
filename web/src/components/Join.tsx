import { useState, type FormEvent } from 'react'
import { useStore } from '../store.ts'
import { ApiError } from '../lib/api.ts'
import { APP_VERSION } from '../lib/pwa.ts'
import { effectiveSsid } from '../lib/settings.ts'
import { isNative, normalizeOrigin, serverOrigin, setServerOrigin } from '../lib/server.ts'

/** Native builds aren't served by the crew server, so they must be told
 * where it is. A `?server=` param (QR-poster deep link) also enables it. */
function needsServerField(): boolean {
  return isNative() || new URLSearchParams(location.search).has('server')
}

function initialServer(): string {
  return new URLSearchParams(location.search).get('server') ?? serverOrigin()
}

export default function Join() {
  const join = useStore((s) => s.join)
  const wifiSsid = useStore((s) => effectiveSsid(s.config.wifiSsid))
  const [name, setName] = useState('')
  const [eventPin, setEventPin] = useState('')
  const [personalPin, setPersonalPin] = useState('')
  const [server, setServer] = useState(initialServer)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const showServer = needsServerField()

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (showServer) {
      if (!normalizeOrigin(server)) {
        setError('Enter the crew server address (it’s on the join poster)')
        return
      }
      setServerOrigin(server)
    }
    setBusy(true)
    try {
      await join(name, eventPin, personalPin)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : `Can't reach the crew server. Check you're connected to ${wifiSsid ?? 'the crew Wi-Fi'}, then try again.`,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="join-screen">
      <form className="join-card" onSubmit={onSubmit}>
        <div className="join-brand">
          <svg viewBox="0 0 48 48" className="join-logo" aria-hidden>
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
          </svg>
          <h1>Crewbox</h1>
          <p>Crew chat that works with no internet</p>
        </div>

        {showServer && (
          <label>
            Crew server
            <input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="e.g. chat.crew.example or 192.168.8.1"
              autoComplete="off"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
            <span className="hint">On the join poster</span>
          </label>
        )}
        <label>
          Your name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Alex (Stage 2)"
            autoComplete="off"
            maxLength={24}
            required
          />
        </label>
        <label>
          Event PIN
          <input
            value={eventPin}
            onChange={(e) => setEventPin(e.target.value)}
            placeholder="On the join poster"
            inputMode="numeric"
            autoComplete="off"
            required
          />
        </label>
        <label>
          Your PIN
          <input
            value={personalPin}
            onChange={(e) => setPersonalPin(e.target.value)}
            placeholder="4–8 digits, remember it"
            inputMode="numeric"
            pattern="\d{4,8}"
            autoComplete="off"
            required
          />
          <span className="hint">Use it to sign back in on any device</span>
        </label>

        {error && <div className="join-error">{error}</div>}

        <button type="submit" disabled={busy}>
          {busy ? 'Joining…' : 'Join'}
        </button>
        <div className="join-version">v{APP_VERSION}</div>
      </form>
    </div>
  )
}
