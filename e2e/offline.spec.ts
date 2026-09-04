import { expect } from '@playwright/test'
import { newDevice, test, uniqueName } from './helpers'

/**
 * The promise the whole product is built on: a message typed in a dead spot
 * is delivered when the phone comes back.
 *
 * It is the first line of `CLAUDE.md` — "offline is the default, not a mode"
 * — and it is why the outbox lives in IndexedDB rather than in memory. It
 * had no test at any layer. The pieces did: the outbox's ordering, the
 * flush's retry policy, the connection banner's threshold. What nobody
 * checked was the sentence a crew member would recognise, end to end,
 * through a real reload.
 */
test('a message typed with no box reaches the crew when it comes back', async ({ browser }) => {
  test.setTimeout(120_000)

  const alex = await newDevice(browser, uniqueName('Alex'))
  const sam = await newDevice(browser, uniqueName('Sam'))
  await expect(alex.getByPlaceholder(/Message/)).toBeVisible()
  await expect(sam.getByPlaceholder(/Message/)).toBeVisible()

  // Cut Alex's socket the way connection.spec does — `setOffline` leaves an
  // established WebSocket alive, and `unrouteAll` will not remove a
  // `routeWebSocket` handler, so the way back is a flag the handler reads.
  let blocked = true
  await alex.routeWebSocket(/\/ws$/, (ws) => {
    if (blocked) ws.close()
    else ws.connectToServer()
  })
  await alex.reload()
  await expect(alex.locator('.conn-banner')).toBeVisible({ timeout: 15_000 })

  // Typed in the dead spot. The app must take it — refusing to accept a
  // message because the box is unreachable is the failure this prevents.
  const body = `radio check from the dead spot ${Date.now().toString(36)}`
  await alex.getByPlaceholder(/Message/).fill(body)
  await alex.getByPlaceholder(/Message/).press('Enter')

  // Shown, and shown as not yet delivered. Both halves matter: a crew member
  // who cannot see what they typed retypes it, and one who cannot tell it is
  // unsent walks away believing it arrived.
  const mine = alex.locator('.msg', { hasText: body })
  await expect(mine).toBeVisible()
  await expect(mine).toHaveClass(/pending/)

  // Nobody else has it, because it has not been anywhere.
  await expect(sam.locator('.msg', { hasText: body })).toBeHidden()

  // The reload is the point. A queue held in memory survives a banner; only
  // one on disk survives a phone that gave up and was reopened — which is
  // what a crew member does when an app "isn't working".
  await alex.reload()
  await expect(alex.locator('.msg', { hasText: body })).toBeVisible({ timeout: 15_000 })

  // The box comes back.
  blocked = false
  await alex.reload()
  await expect(alex.locator('.conn-banner')).toBeHidden({ timeout: 30_000 })

  // Delivered, to the other phone, without anybody pressing anything.
  await expect(sam.locator('.msg', { hasText: body })).toBeVisible({ timeout: 30_000 })
  // And no longer marked unsent on the phone that wrote it.
  await expect(alex.locator('.msg', { hasText: body })).not.toHaveClass(/pending/)
  // Exactly once: a flush that resent what it had already delivered would
  // put the same line in the channel twice, which on a show log-adjacent
  // channel reads as two separate calls.
  await expect(sam.locator('.msg', { hasText: body })).toHaveCount(1)
})
