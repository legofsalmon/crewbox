import { useEffect, useState } from 'react'
import { useStore, type AlertBanner as Alert } from '../store.ts'

/** Long enough to read two lines and reach for it. The badge keeps it after. */
const SHOWN_MS = 6000

/**
 * A mention or DM that arrived while the app was on screen, and where it is
 * (see `announce` in the store). Tapping it goes there.
 *
 * The region is always present, so a screen reader hears each banner as it
 * arrives: a live region that appears with its content already in it is not
 * reliably read out.
 */
export default function AlertBanner() {
  const banner = useStore((s) => s.alertBanner)
  return (
    <div role="status" className="alert-banner-region">
      {banner && <Shown key={banner.id} banner={banner} />}
    </div>
  )
}

/**
 * One banner. It goes by itself, but not while a pointer or the keyboard is
 * on it: somebody reaching for it should not have it taken away.
 */
function Shown({ banner }: { banner: Alert }) {
  const openAlertBanner = useStore((s) => s.openAlertBanner)
  const dismissAlertBanner = useStore((s) => s.dismissAlertBanner)
  const [held, setHeld] = useState(false)

  useEffect(() => {
    if (held) return
    const timer = setTimeout(() => dismissAlertBanner(banner.id), SHOWN_MS)
    return () => clearTimeout(timer)
  }, [held, banner.id, dismissAlertBanner])

  return (
    <div
      className="alert-banner"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <button className="alert-banner-open" onClick={openAlertBanner}>
        <span className="alert-banner-title">{banner.title}</span>
        {banner.body && <span className="alert-banner-body">{banner.body}</span>}
      </button>
      <button
        className="alert-banner-close"
        aria-label="Dismiss"
        onClick={() => dismissAlertBanner(banner.id)}
      >
        ×
      </button>
    </div>
  )
}
