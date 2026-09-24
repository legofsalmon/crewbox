import { useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useStore } from '../store.ts'
import { addressOf, nearby, useBoxSearch } from '../lib/discovery.ts'
import { knownEvents, openEvent, subscribeKnownEvents } from '../lib/eventScope.ts'
import { ApiError } from '../lib/api.ts'
import { APP_VERSION } from '../lib/pwa.ts'
import { displayName, effectiveSsid } from '../lib/settings.ts'
import { readJoinCode } from '../lib/joinCode.ts'
import {
  iphoneRefusesPlainHttp,
  isIosApp,
  isNative,
  nativeScanner,
  normalizeOrigin,
  serverOrigin,
  setServerOrigin,
  type ScanOutcome,
} from '../lib/server.ts'
import type { PickedBox } from '../lib/boxes.ts'
import { NearbyBoxes } from './NearbyBoxes.tsx'

/** Native builds aren't served by the crew server, so they must be told
 * where it is. A `?server=` param (QR-poster deep link) also enables it. */
function needsServerField(): boolean {
  return isNative() || new URLSearchParams(location.search).has('server')
}

function initialServer(): string {
  return new URLSearchParams(location.search).get('server') ?? serverOrigin()
}

/** The QR on the poster/connect page carries ?pin= so crew never type it. */
function initialEventPin(): string {
  return new URLSearchParams(location.search).get('pin') ?? ''
}

/**
 * Said now, rather than after a timeout as "can't reach the server": the
 * iPhone app would refuse the address without trying it.
 */
function iphoneRefusal(origin: string): string | null {
  if (!isIosApp() || !iphoneRefusesPlainHttp(origin)) return null
  return (
    `An iPhone only connects to a name like ${new URL(origin).hostname} over HTTPS. ` +
    'Type https:// before it if the box has a certificate, or use the box’s IP address, like 192.168.8.1.'
  )
}

/** Why a scan filled nothing in, or null when there is nothing to say. */
function scanTrouble(outcome: ScanOutcome | { result: 'failed' }): string | null {
  switch (outcome.result) {
    case 'scanned':
    case 'cancelled':
      return null
    case 'denied':
      return isIosApp()
        ? 'Crewbox isn’t allowed to use the camera. Switch on Camera for Crewbox in Settings, ' +
            'or type the address from the join poster.'
        : 'Crewbox isn’t allowed to use the camera. Allow it in Settings, or type the address ' +
            'from the join poster.'
    case 'unavailable':
      return 'This phone can’t scan codes. Type the address from the join poster.'
    case 'failed':
      return 'The camera didn’t start. Try again, or type the address from the join poster.'
  }
}

export default function Join() {
  const join = useStore((s) => s.join)
  const wifiSsid = useStore((s) => effectiveSsid(s.config.wifiSsid))
  const eventName = useStore((s) => displayName(s.config.eventName))
  const [name, setName] = useState('')
  const [eventPin, setEventPin] = useState(initialEventPin)
  const [personalPin, setPersonalPin] = useState('')
  const [server, setServer] = useState(initialServer)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const showServer = needsServerField()
  const setBoxesOpen = useStore((s) => s.setBoxesOpen)
  const events = useSyncExternalStore(subscribeKnownEvents, knownEvents)
  // A phone that opened another event to join it, and would rather go back.
  const otherEvents = events.some((event) => event.id !== openEvent())
  // In the apps, the boxes on this Wi-Fi, one tap to fill in the address.
  const search = useBoxSearch(showServer)
  const found = useMemo(() => nearby(search.services, events), [search.services, events])
  const [picked, setPicked] = useState<string>()
  const nameField = useRef<HTMLInputElement>(null)
  // In the apps, the join poster's QR fills in the address and the event PIN.
  const scanner = showServer ? nativeScanner() : undefined
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState<string | null>(null)
  const [cameraDenied, setCameraDenied] = useState(false)

  function onPick(box: PickedBox) {
    // As a poster prints it where that is enough; a name only works over HTTPS.
    setServer(box.origin.startsWith('https:') ? box.origin : addressOf(box.origin))
    setPicked(box.origin)
    setError(null)
    setScanned(null)
    setCameraDenied(false)
    if (!name) nameField.current?.focus()
  }

  async function onScan() {
    if (!scanner) return
    setError(null)
    setScanned(null)
    setCameraDenied(false)
    setScanning(true)
    let outcome: ScanOutcome | { result: 'failed' }
    try {
      outcome = await scanner.scan()
    } catch {
      outcome = { result: 'failed' }
    } finally {
      setScanning(false)
    }
    if (outcome.result !== 'scanned') {
      setError(scanTrouble(outcome))
      setCameraDenied(outcome.result === 'denied')
      return
    }
    const code = readJoinCode(outcome.text)
    if (code.kind === 'wifi') {
      setError(
        `That code is for the Wi-Fi${code.ssid ? `, ${code.ssid}` : ''}. Join it with this ` +
          'phone’s camera or its Wi-Fi settings, then scan the crew code on the join poster.'
      )
      return
    }
    if (code.kind === 'other') {
      setError(
        'That isn’t the crew code. Scan the QR on the join poster, or type the address under it.'
      )
      return
    }
    // As a poster prints it where that is enough; a name only works over HTTPS.
    setServer(code.origin.startsWith('https:') ? code.origin : addressOf(code.origin))
    setPicked(code.origin)
    if (code.pin) setEventPin(code.pin)
    const refusal = iphoneRefusal(code.origin)
    if (refusal) {
      setError(refusal)
      return
    }
    setScanned(
      code.pin
        ? `Filled in ${addressOf(code.origin)} and the event PIN from the poster.`
        : `Filled in ${addressOf(code.origin)}. The event PIN is on the poster.`
    )
    if (!name) nameField.current?.focus()
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setCameraDenied(false)
    if (showServer) {
      const origin = normalizeOrigin(server)
      if (!origin) {
        setError('Enter the crew server address (it’s on the join poster)')
        return
      }
      const refusal = iphoneRefusal(origin)
      if (refusal) {
        setError(refusal)
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
          : `Can't reach the crew server. Check you're connected to ${wifiSsid ?? 'the crew Wi-Fi'}, then try again.`
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
          <h1>{eventName}</h1>
          <p>Crew chat that works with no internet</p>
        </div>

        {showServer && (
          <NearbyBoxes
            search={search}
            boxes={found.boxes}
            action="Pick"
            picked={picked && normalizeOrigin(server) === picked ? picked : undefined}
            disabled={busy}
            onPick={onPick}
          />
        )}
        {scanner && (
          <div className="join-scan">
            <button
              type="button"
              className="admin-btn"
              disabled={busy || scanning}
              onClick={() => void onScan()}
            >
              {scanning ? 'Scanning…' : 'Scan the join poster'}
            </button>
            {scanned && (
              <p className="join-scan-note" role="status">
                {scanned}
              </p>
            )}
          </div>
        )}
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
            ref={nameField}
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
        {cameraDenied && (
          <button
            type="button"
            className="admin-btn join-settings"
            onClick={() => void scanner?.openSettings().catch(() => {})}
          >
            Open Settings
          </button>
        )}

        <button type="submit" disabled={busy}>
          {busy ? 'Joining…' : 'Join'}
        </button>
        {otherEvents && (
          <button type="button" className="join-boxes" onClick={() => setBoxesOpen(true)}>
            Your other boxes
          </button>
        )}
        <div className="join-version">v{APP_VERSION}</div>
      </form>
    </div>
  )
}
