import { useState } from 'react'
import { isNative } from '../lib/server.ts'

const DISMISS_KEY = 'inter:ios-tip-dismissed'

function isIosSafariBrowser(): boolean {
  if (isNative()) return false // the native app needs no home-screen install
  const ua = navigator.userAgent
  const isIos = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1)
  const standalone = (navigator as { standalone?: boolean }).standalone === true
  return isIos && !standalone
}

/** One-time nudge for iOS users: installed PWAs behave far better on site. */
export default function IosInstallTip() {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === '1' || !isIosSafariBrowser(),
  )
  if (dismissed) return null
  return (
    <div className="ios-tip" role="note">
      <span>
        Add Inter to your home screen for the best experience:{' '}
        <svg viewBox="0 0 24 24" width="15" height="15" aria-label="Share" style={{ verticalAlign: '-2px' }}>
          <path
            d="M12 3v12M8 6.5 12 3l4 3.5M5 11v8a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>{' '}
        Share → <strong>Add to Home Screen</strong>
      </span>
      <button
        aria-label="Dismiss"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, '1')
          setDismissed(true)
        }}
      >
        ✕
      </button>
    </div>
  )
}
