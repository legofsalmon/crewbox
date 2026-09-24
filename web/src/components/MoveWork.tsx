import { useEffect, useState, useSyncExternalStore } from 'react'
import { useStore } from '../store.ts'
import {
  answerMove,
  knownEvent,
  knownEvents,
  openEvent,
  subscribeKnownEvents,
  type KnownEvent,
} from '../lib/eventScope.ts'
import {
  hasWork,
  movableOf,
  movedCopy,
  moveWork,
  offerCopy,
  toOffer,
  type Movable,
  type MoveResult,
} from '../lib/moveWork.ts'

/**
 * "Bring your work across?", and then what the move did.
 *
 * Asked of an event whose box has been taken over, now that this device has
 * joined the box that took over: once by itself when that box's admin says
 * it carries the event on, and whenever the event's row in Your boxes is
 * tapped.
 */
export function MoveWorkDialog({
  from,
  held,
  onClose,
}: {
  from: KnownEvent
  held: Movable
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [result, setResult] = useState<MoveResult | null>(null)

  async function onMove() {
    setBusy(true)
    setFailed(false)
    try {
      setResult(await moveWork(from.id))
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  function onNotNow() {
    answerMove(from.id, false)
    onClose()
  }

  if (result) {
    const { heading, lines } = movedCopy(result)
    return (
      <div
        className="search-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="confirm-panel" role="dialog" aria-label={heading}>
          <h3>{heading}</h3>
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <div className="confirm-actions">
            <button className="confirm-go" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  const { lede, items } = offerCopy(from, held)
  return (
    // No closing it by tapping beside it: it is asked once, and a stray tap
    // is not an answer.
    <div className="search-overlay" onKeyDown={(e) => e.key === 'Escape' && !busy && onNotNow()}>
      <div className="confirm-panel" role="dialog" aria-label="Bring your work across?">
        <h3>Bring your work across?</h3>
        <p>{lede}</p>
        <ul className="move-items">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p>
          Documents merge with this box’s, and messages go to the channels with the same names. The
          old chat stays on this phone to read.
        </p>
        {failed && (
          <div className="join-error">This phone could not bring it all across. Try again.</div>
        )}
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={onNotNow} disabled={busy}>
            Not now
          </button>
          <button className="confirm-go" onClick={() => void onMove()} disabled={busy}>
            {busy ? 'Moving…' : 'Move it here'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Asks, once, after this device has joined a box its admin says carries on
 * an event this device holds, whether to bring that event's work across.
 */
export default function MoveWorkOffer() {
  const ready = useStore((s) => s.phase === 'chat' && s.hasConnected && !s.elsewhere)
  // Not over Your boxes, where the same event's row offers it, nor over the
  // admin panel, where the admin saying so has only just said it.
  const boxesOpen = useStore((s) => s.boxesOpen || s.adminOpen)
  const events = useSyncExternalStore(subscribeKnownEvents, knownEvents)
  const candidate = ready ? toOffer(events, openEvent())?.id : undefined
  const [asking, setAsking] = useState<{ from: KnownEvent; held: Movable } | null>(null)

  useEffect(() => {
    if (!candidate || asking || boxesOpen) return
    let live = true
    void movableOf(candidate).then((held) => {
      const from = knownEvent(candidate)
      if (!live || !from) return
      if (hasWork(held)) setAsking({ from, held })
      // This device holds nothing of it: nothing to ask, now or later.
      else answerMove(candidate, true)
    })
    return () => {
      live = false
    }
  }, [candidate, asking, boxesOpen])

  if (!asking || boxesOpen) return null
  return <MoveWorkDialog from={asking.from} held={asking.held} onClose={() => setAsking(null)} />
}
