import { expect, test } from '@playwright/test'
import { newDevice, uniqueName } from './helpers'

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
