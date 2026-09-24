import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { signedInTo, useStore } from '../store.ts'
import {
  findBox,
  forgetCopy,
  forgetEvent,
  holdingsOf,
  lastHere,
  type Holdings,
} from '../lib/boxes.ts'
import { refusedCopy } from '../lib/connscreen.ts'
import { addressOf, nearby, useBoxSearch } from '../lib/discovery.ts'
import { useFollowBoxes } from '../lib/follow.ts'
import {
  knownEvent,
  knownEvents,
  openEvent,
  subscribeKnownEvents,
  type KnownEvent,
} from '../lib/eventScope.ts'
import { checkMove } from '../lib/identity.ts'
import { hasWork, movableOf, type Movable } from '../lib/moveWork.ts'
import { isNative, normalizeOrigin } from '../lib/server.ts'
import {
  clearJoinLink,
  currentJoinLink,
  subscribeJoinLink,
  type JoinLink,
} from '../lib/appLinks.ts'
import { MoveWorkDialog } from './MoveWork.tsx'
import { NearbyBoxes } from './NearbyBoxes.tsx'

const nameOf = (event: KnownEvent): string => event.name.trim() || 'No name yet'

/**
 * The events this device holds, one tap to open each, Forget, and in the app
 * the boxes on this Wi-Fi and a way to a box at another address.
 *
 * Reached from the menu, from the join screen, and from the screens that say
 * the box cannot be reached, which offered only Retry to a phone whose box
 * had moved: now it can be told where the box went.
 */
export default function Boxes() {
  const setBoxesOpen = useStore((s) => s.setBoxesOpen)
  const switchEvent = useStore((s) => s.switchEvent)
  const openEventAt = useStore((s) => s.openEventAt)
  const events = useSyncExternalStore(subscribeKnownEvents, knownEvents)
  const signedIn = useStore((s) => s.phase === 'chat')
  const open = openEvent()
  const [holdings, setHoldings] = useState<Record<string, Holdings>>({})
  // For an event whose box came back as the open one: what could come here.
  const [movable, setMovable] = useState<Record<string, Movable>>({})
  const [forgetting, setForgetting] = useState<KnownEvent | null>(null)
  // Held apart from `movable`, which a move changes while its answer is showing.
  const [moving, setMoving] = useState<{ from: KnownEvent; held: Movable } | null>(null)
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A typed box that failed the check, with the key it offered instead.
  const [refused, setRefused] = useState<{
    id: string
    name: string
    origin: string
    key: string
  } | null>(null)
  const search = useBoxSearch()
  // This device's other events, found at new addresses and proven there,
  // are listed there: on this Wi-Fi, and opened where they are.
  useFollowBoxes(search.services, 'others')
  const found = useMemo(() => nearby(search.services, events), [search.services, events])
  const close = () => {
    if (!busy) setBoxesOpen(false)
  }

  // A crewbox://join link for another box, tapped while this phone is signed
  // in (App.tsx opens this for it): its address, ready to Connect, and the
  // event PIN it carried, for that box's join form. The join form takes a
  // link itself when that is what is showing.
  const link = useSyncExternalStore(subscribeJoinLink, currentJoinLink)
  const [linked, setLinked] = useState<JoinLink | null>(null)
  const addressForm = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (!link || !signedIn) return
    clearJoinLink()
    setLinked(link)
    setAddress(link.origin.startsWith('https:') ? link.origin : addressOf(link.origin))
    setError(null)
    setRefused(null)
    addressForm.current?.scrollIntoView?.({ block: 'nearest' })
  }, [link, signedIn])

  useEffect(() => {
    let live = true
    void Promise.all(events.map(async (event) => [event.id, await holdingsOf(event.id)] as const))
      .then((entries) => {
        if (live) setHoldings(Object.fromEntries(entries))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [events])

  useEffect(() => {
    let live = true
    const replaced = signedIn ? events.filter((event) => open && event.replacedBy === open) : []
    void Promise.all(replaced.map(async (event) => [event.id, await movableOf(event.id)] as const))
      .then((entries) => {
        if (live) setMovable(Object.fromEntries(entries))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [events, open, signedIn])

  const now = Date.now()
  const rows = [...events].sort((a, b) => {
    if (a.id === open) return -1
    if (b.id === open) return 1
    return b.seenAt - a.seenAt
  })

  async function onFind(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setRefused(null)
    setBusy(true)
    const found = await findBox(address)
    // An event this phone holds somewhere else has to be that event's box
    // (lib/identity.ts). The address is theirs, so one that can't be
    // checked is taken at their word; one that fails is said so first.
    const proof = found.kind === 'event' ? await checkMove(found.id, found.origin) : null
    setBusy(false)
    if (found.kind === 'event' && proof?.kind === 'refused') {
      setError(
        refusedCopy({
          address: addressOf(found.origin),
          name: knownEvent(found.id)?.name || found.name,
        })
      )
      if (proof.key)
        setRefused({ id: found.id, name: found.name, origin: found.origin, key: proof.key })
      return
    }
    switch (found.kind) {
      case 'invalid':
        setError(found.message)
        return
      case 'unreachable':
        setError(
          `Nothing answered at ${addressOf(found.origin)}. Check this phone is on the crew ` +
            'Wi-Fi, and that the address is the one on the join poster.'
        )
        return
      case 'too-old':
        setError(
          `The box at ${addressOf(found.origin)} runs an older crewbox, which does not say ` +
            'which event it is. Update it from its admin panel, then try again.'
        )
        return
      case 'event':
        openEventAt({
          id: found.id,
          name: found.name,
          origin: found.origin,
          // The link's PIN, while the address is still the link's.
          ...(linked && linked.origin === found.origin ? { pin: linked.pin } : {}),
        })
    }
  }

  async function onForget(event: KnownEvent) {
    setBusy(true)
    setError(null)
    try {
      await forgetEvent(event.id)
      setForgetting(null)
    } catch {
      setError('This phone could not forget it. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (moving) {
    return <MoveWorkDialog from={moving.from} held={moving.held} onClose={() => setMoving(null)} />
  }

  if (forgetting) {
    const copy = forgetCopy(
      holdings[forgetting.id] ?? { documents: 0, unsentMessages: 0, unsentEntries: 0 }
    )
    return (
      <div
        className="search-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy) setForgetting(null)
        }}
        onKeyDown={(e) => e.key === 'Escape' && !busy && setForgetting(null)}
      >
        <div className="confirm-panel" role="dialog" aria-label={`Forget ${nameOf(forgetting)}`}>
          <h3>Forget {nameOf(forgetting)}?</h3>
          <p>{copy.gone}</p>
          {copy.lost && <p className="boxes-lost">{copy.lost}</p>}
          {error && <div className="join-error">{error}</div>}
          <div className="confirm-actions">
            <button className="confirm-cancel" onClick={() => setForgetting(null)} disabled={busy}>
              Cancel
            </button>
            <button
              className="confirm-delete"
              onClick={() => void onForget(forgetting)}
              disabled={busy}
            >
              {busy ? 'Forgetting…' : 'Forget'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="search-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
      onKeyDown={(e) => e.key === 'Escape' && close()}
    >
      <div className="boxes-panel" role="dialog" aria-label="Your boxes">
        <h3>Your boxes</h3>
        <p className="boxes-lede">
          Each event keeps its own messages, documents and unsent work on this device.
        </p>

        {rows.length > 0 && (
          <ul className="boxes-list" aria-label="Events on this device">
            {rows.map((event) => {
              const isOpen = event.id === open
              const kept = holdings[event.id]
              const unsent = kept ? kept.unsentMessages + kept.unsentEntries : 0
              const held = movable[event.id]
              const status = isOpen
                ? ''
                : signedInTo(event.id)
                  ? lastHere(event.seenAt, now)
                  : event.seenAt
                    ? 'Signed out'
                    : 'Not joined yet'
              const detail = [
                event.origin ? addressOf(event.origin) : '',
                status,
                found.here.has(event.id) ? 'On this Wi-Fi' : '',
              ]
                .filter(Boolean)
                .join(' · ')
              const body = (
                <>
                  <span className="boxes-name">{nameOf(event)}</span>
                  {detail && <span className="boxes-detail">{detail}</span>}
                  {unsent > 0 && <span className="boxes-unsent">{unsent} unsent</span>}
                </>
              )
              return (
                <li key={event.id} className="boxes-row">
                  {isOpen ? (
                    <div className="boxes-pick" aria-current="true">
                      {body}
                    </div>
                  ) : (
                    <button className="boxes-pick" onClick={() => switchEvent(event.id)}>
                      {body}
                    </button>
                  )}
                  {isOpen ? (
                    <span className="boxes-badge">Open</span>
                  ) : (
                    <button
                      className="admin-btn"
                      aria-label={`Forget ${nameOf(event)}`}
                      onClick={() => {
                        setError(null)
                        setForgetting(event)
                      }}
                    >
                      Forget
                    </button>
                  )}
                  {held && hasWork(held) && (
                    <div className="boxes-move">
                      <span>Its box started afresh.</span>
                      <button
                        className="admin-btn admin-btn-primary"
                        onClick={() => {
                          setError(null)
                          setMoving({ from: event, held })
                        }}
                      >
                        Bring its work here
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <NearbyBoxes
          search={search}
          boxes={found.boxes}
          action="Join"
          disabled={busy}
          onPick={openEventAt}
        />

        {isNative() && (
          <form ref={addressForm} className="boxes-address" onSubmit={(e) => void onFind(e)}>
            <label htmlFor="boxes-address">Another box</label>
            <div className="boxes-address-row">
              <input
                id="boxes-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="e.g. 192.168.8.1"
                autoComplete="off"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <button type="submit" className="admin-btn admin-btn-primary" disabled={busy}>
                {busy ? 'Looking…' : 'Connect'}
              </button>
            </div>
            <span className="hint">
              {linked && normalizeOrigin(address) === linked.origin
                ? 'From the link. Connect to open it.'
                : 'Its address, from the join poster'}
            </span>
          </form>
        )}
        {error && <div className="join-error">{error}</div>}
        {refused && (
          <div className="boxes-refused">
            <p className="hint">
              It may be that event’s box, restored from an old backup, which can’t show it. Open it
              anyway only if you are sure.
            </p>
            <button
              className="admin-btn danger"
              onClick={() => {
                setRefused(null)
                openEventAt(refused)
              }}
            >
              Open it anyway
            </button>
          </div>
        )}

        <div className="boxes-actions">
          <button className="admin-btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
