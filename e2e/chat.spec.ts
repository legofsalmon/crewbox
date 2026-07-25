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
