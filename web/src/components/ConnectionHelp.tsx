import { useStore } from '../store.ts'
import { connectionCauses } from '../lib/connscreen.ts'
import { isIOS } from '../lib/devices.ts'
import { effectiveSsid } from '../lib/settings.ts'
import { serverLabel } from '../lib/server.ts'

/**
 * Why the box has been unreachable for a while — opened from the connection
 * banner once it stops being a blip.
 *
 * A panel rather than a takeover, deliberately. A returning user still has
 * every message, patch sheet and plot on their own device, and anything they
 * type is queued and delivers on reconnect; replacing that with an error
 * screen would treat offline as a fault, which in this product it is not.
 * So the app keeps working underneath and this explains itself on request.
 */
export default function ConnectionHelp({ onClose }: { onClose: () => void }) {
  const retryConnection = useStore((s) => s.retryConnection)
  const connection = useStore((s) => s.connection)
  const wifiSsid = useStore((s) => effectiveSsid(s.config.wifiSsid))
  const retrying = connection === 'connecting'
  const causes = connectionCauses({ ...(wifiSsid ? { ssid: wifiSsid } : {}), isIos: isIOS() })

  return (
    <div
      className="search-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="conn-help" role="dialog" aria-label="Connection help">
        <h3>Still not connected</h3>
        <p className="conn-help-lede">
          Everything you can see is stored on this device, and anything you send is queued and
          delivers the moment the box is back. Nothing is lost while this lasts.
        </p>

        <ol className="conn-help-causes">
          {causes.map((cause) => (
            <li key={cause.heading}>
              <strong>{cause.heading}</strong>
              <span>{cause.body}</span>
            </li>
          ))}
        </ol>

        <div className="conn-help-actions">
          <button className="center-retry" onClick={retryConnection} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry now'}
          </button>
          <button className="admin-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="center-meta">Trying {serverLabel()} · retrying automatically</div>
      </div>
    </div>
  )
}
