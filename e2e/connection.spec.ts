import { expect, test } from '@playwright/test'
import { newDevice } from './helpers'

/**
 * What a returning crew member sees when the box genuinely goes away.
 *
 * This is the failure that cost a real event an hour: the app opened from
 * its own storage, everything rendered, the banner said "Connecting", and
 * nothing anywhere said why or suggested looking at the phone's own status
 * bar — where the answer was.
 *
 * The wait is real rather than stubbed, because the threshold *is* the
 * feature: a roam or a box restart must never trigger this, and a genuine
 * outage must. A test with a faked clock would pass just as happily with the
 * threshold set to zero, which is the one thing worth ruling out.
 */
test('a sustained outage turns the banner into an explanation', async ({ browser }) => {
  test.setTimeout(120_000)

  const page = await newDevice(browser)

  // Cached and working first, so this is the returning-user path rather than
  // the cold-start recovery screen.
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  // Cut the socket, with a way back. Two notes for whoever touches this next:
  //
  //  - context.setOffline() is not enough. It leaves an already-established
  //    WebSocket alive, so the app carries on talking and never notices.
  //  - unrouteAll() does not remove a routeWebSocket handler, so the way back
  //    is a flag the handler reads rather than removing the route.
  //
  // Blocking and reloading reproduces the reported failure exactly: the app
  // comes up from its own storage, everything renders, and the one thing it
  // cannot have is the connection it needs.
  let blocked = true
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (blocked) ws.close()
    else ws.connectToServer()
  })
  await page.reload()

  // Immediately: the socket is refused rather than quietly idle, so there is
  // nothing to wait for.
  await expect(page.locator('.conn-banner')).toBeVisible({ timeout: 15_000 })
  // A blip says nothing new — the ordinary banner, no invitation to read on.
  await expect(page.getByRole('button', { name: /Why\?/ })).toBeHidden()

  // Past the threshold it offers to explain itself.
  const why = page.getByRole('button', { name: /Why\?/ })
  await expect(why).toBeVisible({ timeout: 45_000 })
  await why.click()

  const help = page.getByRole('dialog', { name: 'Connection help' })
  await expect(help).toBeVisible()
  // The reassurance matters as much as the causes: crew force-quit the app
  // when they think their unsent messages have gone with the connection.
  await expect(help).toContainText(/stored on this device/)
  await expect(help).toContainText(/queued/)

  // The app underneath is still the app. Offline is not an error state here,
  // so the explanation is dismissible and leaves everything working.
  await help.getByRole('button', { name: 'Close' }).click()
  await expect(help).toBeHidden()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  // And none of it is sticky once the box is back.
  blocked = false
  await page.reload()
  await expect(page.locator('.conn-banner')).toBeHidden({ timeout: 30_000 })
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
})
