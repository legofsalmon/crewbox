import { useState } from 'react'
import { checkFound, type PickedBox } from '../lib/boxes.ts'
import {
  addressOf,
  openLocalNetworkSettings,
  searchNow,
  type NearbyBox,
  type Search,
} from '../lib/discovery.ts'
import { isIosApp } from '../lib/server.ts'

const nameOf = (box: NearbyBox): string => box.eventName || 'No name yet'

/**
 * Boxes on this Wi-Fi, in the apps: the join screen's and the Boxes screen's.
 *
 * What the search has found, one tap to use each. Only boxes running an event
 * this device does not hold are listed; the Boxes screen marks its own rows
 * when their box is here. Where the search cannot run, or has found nothing,
 * it says why in a line, and the address field beside it is the way on.
 */
export function NearbyBoxes({
  search,
  boxes,
  action,
  picked,
  disabled,
  onPick,
}: {
  search: Search
  boxes: NearbyBox[]
  /** The row button's word: what picking a box does here. */
  action: string
  /** The origin already picked, marked as such. */
  picked?: string
  disabled?: boolean
  onPick: (box: PickedBox) => void
}) {
  const [checking, setChecking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (search.state === 'off') return null

  async function pick(box: NearbyBox) {
    setError(null)
    setChecking(box.origin)
    const result = await checkFound(box)
    setChecking(null)
    if (result.ok) onPick(result.box)
    else setError(result.message)
  }

  let note: string | null = null
  switch (search.state) {
    case 'ask':
      note =
        'Crewbox can find the box on this Wi-Fi for you. Your iPhone will ask to let it find ' +
        'devices on your local network: allow it, and the boxes here show up.'
      break
    case 'denied':
      note = isIosApp()
        ? 'This iPhone doesn’t let Crewbox look on the local network. Switch on Local Network ' +
          'for Crewbox in Settings, or type the address from the join poster.'
        : 'This phone doesn’t let Crewbox look on the local network. Type the address from ' +
          'the join poster.'
      break
    case 'waiting':
      note = 'Waiting for a network. Check this phone is on the crew Wi-Fi.'
      break
    case 'failed':
      note = 'This phone couldn’t look for boxes. Type the address from the join poster.'
      break
    case 'searching':
      if (boxes.length === 0) {
        note = search.quiet
          ? 'No boxes found on this Wi-Fi. Check this phone is on the crew Wi-Fi, or type ' +
            'the address from the join poster.'
          : 'Looking for boxes on this Wi-Fi…'
      }
  }

  return (
    <section className="nearby" aria-label="Boxes on this Wi-Fi">
      <h4 className="nearby-title">On this Wi-Fi</h4>
      {note && (
        <p className="nearby-note" role="status">
          {note}
        </p>
      )}
      {search.state === 'ask' && (
        <button type="button" className="admin-btn admin-btn-primary" onClick={searchNow}>
          Find boxes
        </button>
      )}
      {search.state === 'denied' && isIosApp() && (
        <button type="button" className="admin-btn" onClick={openLocalNetworkSettings}>
          Open Settings
        </button>
      )}
      {boxes.length > 0 && (
        <ul className="boxes-list" aria-label="Boxes found on this Wi-Fi">
          {boxes.map((box) => {
            const isPicked = box.origin === picked
            return (
              <li key={box.origin} className="boxes-row nearby-row">
                <div className="boxes-pick">
                  <span className="boxes-name">{nameOf(box)}</span>
                  <span className="boxes-detail">{box.address}</span>
                  {box.setUp && box.carries !== undefined && (
                    <span className="boxes-detail">
                      {box.carries
                        ? `Carries on ${box.carries}`
                        : 'Carries on an event this phone has'}
                    </span>
                  )}
                  {!box.setUp && (
                    <span className="nearby-warn">
                      Not set up yet. Open {addressOf(box.origin)}/setup in a browser to set it up.
                    </span>
                  )}
                  {box.setUp && box.lookalike && (
                    <span className="nearby-warn">
                      Another box here has the same name. Check the address on the join poster.
                    </span>
                  )}
                </div>
                {isPicked ? (
                  <span className="boxes-badge">Picked</span>
                ) : (
                  box.setUp && (
                    <button
                      type="button"
                      className="admin-btn admin-btn-primary"
                      aria-label={`${action} ${nameOf(box)}`}
                      disabled={disabled || checking !== null}
                      onClick={() => void pick(box)}
                    >
                      {checking === box.origin ? 'Checking…' : action}
                    </button>
                  )
                )}
              </li>
            )
          })}
        </ul>
      )}
      {error && <div className="join-error">{error}</div>}
    </section>
  )
}
