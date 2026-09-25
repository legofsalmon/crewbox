import { expect } from '@playwright/test'
import { newDevice, test, uniqueName } from './helpers'

/** Shell regression guard: chat still works end to end around the module seam. */
test('two crew members chat in #general and deep-link back into the channel', async ({
  browser,
}) => {
  const deviceA = await newDevice(browser)
  const deviceB = await newDevice(browser)

  const message = uniqueName('Doors in 30 —')
  await deviceA.getByPlaceholder(/Message/).fill(message)
  await deviceA.keyboard.press('Enter')

  await expect(deviceA.getByText(message)).toBeVisible()
  await expect(deviceB.getByText(message)).toBeVisible()

  // Channel routes survive a reload (Phase 1 routing).
  await expect(deviceA).toHaveURL(/\/c\//)
  await deviceA.reload()
  await expect(deviceA.getByText(message)).toBeVisible()
})

/**
 * A half-typed message must survive a channel switch.
 *
 * Crew flick between channels constantly — check the stage channel, glance at
 * FOH — and losing an in-progress message every time you do is the kind of
 * small betrayal that makes a tool feel untrustworthy. Drafts are per-channel
 * and kept for the session.
 */
test('an unsent draft survives switching channels and comes back', async ({ browser }) => {
  const page = await newDevice(browser)

  // A second channel to switch to.
  await page.getByRole('button', { name: 'New channel' }).click()
  await page.getByPlaceholder('channel-name').fill('stage')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '#stage' })).toBeVisible()

  // Type a draft in #general without sending it.
  await page.getByRole('button', { name: '#general' }).click()
  const draft = uniqueName('cue stack is —')
  const composer = page.getByPlaceholder(/Message/)
  await composer.fill(draft)

  // #stage has its own (empty) draft.
  await page.getByRole('button', { name: '#stage' }).click()
  await expect(composer).toHaveValue('')

  // Back in #general, the half-typed message is exactly as it was left.
  await page.getByRole('button', { name: '#general' }).click()
  await expect(composer).toHaveValue(draft)
})

/**
 * With a mouse and keyboard, switching channel still lands the caret in the
 * composer. This is the half of the behaviour worth keeping — it saves a
 * click for the crew chief typing all night at the production desk — and the
 * half that made suppressing it on a phone a fix rather than a removal.
 */
test('switching channel with a keyboard puts the caret in the composer', async ({ browser }) => {
  const page = await newDevice(browser)

  await page.getByRole('button', { name: 'New channel' }).click()
  await page.getByPlaceholder('channel-name').fill('foh')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '#foh' })).toBeVisible()

  // Via #foh, so the last click is a real channel change wherever creating
  // one happens to land.
  await page.getByRole('button', { name: '#foh' }).click()
  await page.getByRole('button', { name: '#general' }).click()
  const composer = page.getByPlaceholder(/Message/)
  await expect(composer).toHaveAttribute('placeholder', 'Message #general')
  await expect(composer).toBeFocused()

  // Typing goes straight into the box, no click needed.
  const message = uniqueName('house open —')
  await page.keyboard.type(message)
  await expect(composer).toHaveValue(message)
})

/** The /connect QR carries ?pin= — scanning prefills the join form. */
test('a ?pin= deep link prefills the event PIN on the join screen', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await expect(page.getByLabel('Event PIN')).toHaveValue('4242')
})

/**
 * Filtering a channel, and links you can actually tap.
 *
 * Both come from the same complaint: a channel that has been running since
 * the get-in is a wall of text, and the thing you need — the address someone
 * pasted, the photo of the patch — is somewhere in it.
 */
test('the filter bar narrows a channel by kind and by person, and links are tappable', async ({
  browser,
}) => {
  const stage = uniqueName('Filter Stage')
  const foh = uniqueName('Filter FOH')
  const deviceA = await newDevice(browser, stage)
  const deviceB = await newDevice(browser, foh)

  const linked = uniqueName('rider is at https://example.com/rider.pdf —')
  const plain = uniqueName('mics are in the blue case —')
  const fromB = uniqueName('on my way —')

  for (const [page, body] of [
    [deviceA, linked],
    [deviceA, plain],
    [deviceB, fromB],
  ] as const) {
    await page.getByPlaceholder(/Message/).fill(body)
    await page.keyboard.press('Enter')
  }
  await expect(deviceA.getByText(fromB)).toBeVisible()

  // The address became a real link, out to the web and not into the app.
  const link = deviceA.getByRole('link', { name: 'https://example.com/rider.pdf' })
  await expect(link).toHaveAttribute('href', 'https://example.com/rider.pdf')
  await expect(link).toHaveAttribute('target', '_blank')
  // The full stop after it stayed in the sentence rather than joining the URL.
  await expect(deviceA.getByText(linked)).toBeVisible()

  await deviceA.getByRole('button', { name: 'Filter messages' }).click()
  await deviceA.getByRole('button', { name: 'Links' }).click()
  await expect(deviceA.getByText(linked)).toBeVisible()
  await expect(deviceA.getByText(plain)).toHaveCount(0)
  await expect(deviceA.getByText(fromB)).toHaveCount(0)

  // Say out loud that this only covers what the phone has loaded.
  await expect(deviceA.getByText(/of \d+ loaded/)).toBeVisible()

  // By person, across all kinds.
  await deviceA.getByRole('button', { name: 'All', exact: true }).click()
  await deviceA.getByLabel('Filter by person').selectOption({ label: foh })
  await expect(deviceA.getByText(fromB)).toBeVisible()
  await expect(deviceA.getByText(linked)).toHaveCount(0)

  await deviceA.getByRole('button', { name: 'Clear' }).click()
  await expect(deviceA.getByText(linked)).toBeVisible()
  await expect(deviceA.getByText(fromB)).toBeVisible()

  // Closing the bar must not leave an invisible filter hiding the channel.
  await deviceA.getByRole('button', { name: 'Links' }).click()
  await deviceA.getByRole('button', { name: 'Hide message filter' }).click()
  await expect(deviceA.getByText(plain)).toBeVisible()
})

/**
 * Somebody needs you while the app is open.
 *
 * The chirp and the buzz said so, and nothing said who or where: on a phone
 * the channel list, whose badge would have, is in the drawer. The banner says
 * who and what, and takes you there.
 */
test('a direct message while the app is open says who, and opens the conversation', async ({
  browser,
}) => {
  const jo = uniqueName('Jo')
  const alex = uniqueName('Alex')
  const joPage = await newDevice(browser, jo)
  const alexPage = await newDevice(browser, alex)

  await alexPage.getByRole('button', { name: `Message ${jo}` }).click()
  // The conversation opens once the box has made it; until then the composer
  // on screen is #general's.
  const toJo = alexPage.getByPlaceholder(`Message ${jo}`)
  await toJo.fill('Can you come to FOH?')
  await toJo.press('Enter')

  // Jo is in #general, with the conversation nowhere on screen.
  const banner = joPage.locator('.alert-banner')
  await expect(banner).toContainText(alex)
  await expect(banner).toContainText('Can you come to FOH?')
  await banner.getByRole('button', { name: /Can you come to FOH/ }).click()
  await expect(banner).toBeHidden()
  await expect(joPage.locator('.msg', { hasText: 'Can you come to FOH?' })).toBeVisible()
  await expect(joPage.getByPlaceholder(new RegExp(`Message ${alex}`))).toBeVisible()

  // Put away without going anywhere, and gone by itself after a while.
  await toJo.fill('Never mind')
  await toJo.press('Enter')
  await joPage.getByRole('button', { name: '#general' }).click()
  await toJo.fill('Actually, please do')
  await toJo.press('Enter')
  await expect(banner).toContainText('Actually, please do')
  await banner.getByRole('button', { name: 'Dismiss' }).click()
  await expect(banner).toBeHidden()
  await expect(joPage.getByPlaceholder('Message #general')).toBeVisible()
  // Off the banner: one with a pointer on it stays until the pointer goes.
  await joPage.mouse.move(10, 600)
  await toJo.fill('Still there?')
  await toJo.press('Enter')
  await expect(banner).toContainText('Still there?')
  await expect(banner).toBeHidden({ timeout: 10_000 })
})
