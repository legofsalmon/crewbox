import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '@crewbox/shared'
import { Hub, TALLY_GRACE_MS } from '../src/hub.ts'
import { Tally } from '../src/control.ts'
import type { Store } from '../src/store.ts'

/**
 * The red bar, and the phone in somebody's pocket.
 *
 * The tally was forgotten the moment an on-air crew member's last socket
 * closed — and iOS closes one about thirty seconds after the app goes to the
 * background. The person on camera is precisely the one who is not holding
 * their phone, so the bar vanished for the whole crew mid-shot because the
 * subject put a device away.
 *
 * "Their last socket closed" is not "they left". A grace period tells the two
 * apart; coming back cancels it, and an account being deleted skips it.
 */

const GRACE = 40

const hubWith = () => {
  const sent: ServerMessage[] = []
  const hub = new Hub(
    {} as Store,
    { info() {}, warn() {}, error() {} } as never,
    () => ({ eventName: '', wifiSsid: '', voiceEnabled: false, modules: [] }),
    undefined,
    false,
    undefined,
    GRACE
  )
  const tally = new Tally(() => 1_000)
  hub.setTally(tally)
  // Broadcasts go to every connection; with none attached, watch the method.
  const original = hub.broadcastTally.bind(hub)
  hub.broadcastTally = (state) => {
    sent.push({ type: 'tally', userId: state.userId, since: state.since })
    original(state)
  }
  const inner = hub as never as {
    markOnline: (id: string, remote: boolean) => void
    markOffline: (id: string, remote: boolean) => void
  }
  return { hub, tally, sent, inner }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('an on-air crew member whose phone drops', () => {
  it('stays on air through a backgrounded app', async () => {
    const { hub, tally, inner } = hubWith()
    inner.markOnline('camera-op', false)
    tally.set('camera-op')

    inner.markOffline('camera-op', false)
    // The gap iOS leaves. Still on camera, still on air.
    await settle(GRACE / 2)
    expect(tally.current().userId).toBe('camera-op')
    hub.close()
  })

  it('is cleared once they really have gone', async () => {
    const { hub, tally, sent, inner } = hubWith()
    inner.markOnline('camera-op', false)
    tally.set('camera-op')

    inner.markOffline('camera-op', false)
    await settle(GRACE * 3)
    expect(tally.current().userId).toBeNull()
    // And the crew are told, or the bar is only right on the box.
    expect(sent.at(-1)).toMatchObject({ type: 'tally', userId: null })
    hub.close()
  })

  it('keeps them on air when they come back', async () => {
    const { hub, tally, inner } = hubWith()
    inner.markOnline('camera-op', false)
    tally.set('camera-op')

    inner.markOffline('camera-op', false)
    await settle(GRACE / 2)
    inner.markOnline('camera-op', false)
    await settle(GRACE * 3)
    expect(tally.current().userId).toBe('camera-op')
    hub.close()
  })

  it('leaves somebody else’s tally alone', async () => {
    const { hub, tally, inner } = hubWith()
    inner.markOnline('camera-op', false)
    inner.markOnline('runner', false)
    tally.set('camera-op')

    inner.markOffline('runner', false)
    await settle(GRACE * 3)
    expect(tally.current().userId).toBe('camera-op')
    hub.close()
  })

  it('clears at once when the account is deleted', async () => {
    // Deliberate departure — no reason to make the crew look at a red bar
    // for five minutes over somebody who has removed themselves.
    const { hub, tally, inner } = hubWith()
    inner.markOnline('camera-op', false)
    tally.set('camera-op')

    hub.disconnectUser('camera-op')
    expect(tally.current().userId).toBeNull()
    hub.close()
  })

  it('holds long enough to cover a shot', () => {
    // The number itself: iOS drops the socket at about thirty seconds, and a
    // shot plus the gap around it is minutes, not seconds.
    expect(TALLY_GRACE_MS).toBeGreaterThanOrEqual(60_000)
    expect(TALLY_GRACE_MS).toBeLessThanOrEqual(15 * 60_000)
  })
})
