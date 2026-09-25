import type { FileOffer } from '../lib/download.ts'
import { dismissFileOffer } from '../lib/download.ts'

/**
 * A file with one more step, at the foot of the app: "Saved to Downloads"
 * with Share on Android, "Ready to save or send" with Share on an iPhone
 * that wanted a fresh tap (lib/download.ts). The name is in full, because
 * it is what to look for in Downloads or Files. It sits with the toasts but,
 * unlike them, takes taps.
 */
export default function FileOfferBar({ offer }: { offer: FileOffer }) {
  return (
    <div className="file-offer" role="status">
      <span className="file-offer-text">
        <strong className="file-offer-title">{offer.title}</strong>
        <span className="file-offer-name">{offer.name}</span>
      </span>
      {offer.action && (
        <button className="file-offer-act" onClick={offer.action.run}>
          {offer.action.label}
        </button>
      )}
      <button className="file-offer-close" aria-label="Dismiss" onClick={dismissFileOffer}>
        ✕
      </button>
    </div>
  )
}
