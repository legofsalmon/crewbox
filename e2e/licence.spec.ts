import { expect, type Page } from '@playwright/test'
import { textContrast } from './contrast.ts'
import { newDevice, test } from './helpers.ts'
import { mintLicenceToken } from './licenceKey.ts'

/**
 * The box's licence, from a browser, under the shipped policy — "trial, then
 * lock".
 *
 * The e2e box starts licensed (e2e/seedLicence.ts). This spec releases it —
 * offline, as it always is in a field, since the suite's licence service is a
 * port nothing answers on — and checks what an unlicensed box is: a banner in
 * the admin console, a small line in every crew drawer, event configuration
 * locked, and crew comms exactly as they were. Then it licenses the box again
 * through offline activation, the way an owner with no signal at the box
 * would: read the request code, get a token for it, paste it in.
 *
 * Serial, and it leaves the box licensed, because every spec after it
 * configures the event.
 */

test.describe.configure({ mode: 'serial' })

const unlock = async (page: Page) => {
  await page.getByRole('button', { name: 'Admin panel' }).click()
  await page.getByLabel('Admin password').fill('e2e-admin-password')
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByRole('heading', { name: 'Crew' })).toBeVisible()
}

test('releasing the licence locks event setup, marks the box, and never touches comms', async ({
  browser,
}) => {
  const admin = await newDevice(browser, 'Licence Admin')
  const crew = await newDevice(browser, 'Licence Crew')

  // Licensed: no marks anywhere.
  await expect(crew.locator('.unlicensed-mark')).toHaveCount(0)
  await unlock(admin)
  await expect(admin.locator('.admin-licence-banner')).toHaveCount(0)
  await expect(admin.locator('.admin-licence-status strong')).toHaveText('Licensed')

  // Release this box. Two presses, like retiring a channel.
  await admin.getByRole('button', { name: 'Release this box' }).click()
  await admin.getByRole('button', { name: 'Really release?' }).click()
  await expect(admin.locator('.admin-panel > .admin-note')).toContainText(
    /could not reach the service/
  )

  // The admin console carries the lock banner, and says what is locked.
  const banner = admin.locator('.admin-licence-banner')
  await expect(banner).toContainText(
    'Unlicensed copy — event setup is locked until you enter a key or start a trial'
  )
  await expect(admin.locator('.admin-licence-status strong')).toHaveText('Unlicensed')
  await expect(admin.locator('.admin-licence-locked')).toBeVisible()
  await expect(admin.getByLabel('Licence key')).toBeVisible()
  await expect(admin.getByLabel('Start a 30-day trial')).toBeVisible()
  await expect(admin.getByText('No internet here? Activate offline')).toBeVisible()

  // The crew drawer picks the mark up live, without a reload.
  await expect(crew.locator('.unlicensed-mark')).toHaveText('Unlicensed')

  // And the crew talk exactly as before: a message goes out and arrives.
  const body = `still talking ${Date.now().toString(36)}`
  await crew.getByPlaceholder(/Message/).fill(body)
  await crew.getByPlaceholder(/Message/).press('Enter')
  await expect(admin.getByText(body)).toBeVisible()

  // A pasted token that is not one is refused in words, and nothing changes.
  await admin.getByLabel('Licence token').fill('not-a-licence-token')
  await admin.getByRole('button', { name: 'Use this token' }).click()
  await expect(admin.locator('.admin-panel > .admin-note')).toContainText(/Nothing was stored/)
  await expect(banner).toBeVisible()
})

test('the unlicensed marks stay readable in both themes', async ({ browser }) => {
  // Light theme is what crew have outdoors in daylight; dark is the FOH tent.
  // The drawer line is deliberately small, which is exactly where a faint
  // token fails AA.
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme: scheme })
    const page = await context.newPage()
    await page.goto('/?pin=4242')
    await page.getByLabel('Your name').fill(`Mark ${scheme}`)
    await page.getByLabel('Your PIN').fill('1234')
    await page.getByRole('button', { name: 'Join' }).click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()

    await expect(page.locator('.unlicensed-mark')).toBeVisible()
    expect(await textContrast(page, '.unlicensed-mark'), `drawer, ${scheme}`).toBeGreaterThan(4.5)

    await unlock(page)
    await expect(page.locator('.admin-licence-banner')).toBeVisible()
    expect(
      await textContrast(page, '.admin-licence-banner span'),
      `banner, ${scheme}`
    ).toBeGreaterThan(4.5)
    expect(
      await textContrast(page, '.admin-licence-status strong'),
      `status, ${scheme}`
    ).toBeGreaterThan(4.5)
    await context.close()
  }
})

test('offline activation: the request code, a token for it, pasted in', async ({ browser }) => {
  const admin = await newDevice(browser, 'Offline Owner')
  const crew = await newDevice(browser, 'Offline Crew')
  await unlock(admin)

  // What the owner types into the account page on their phone.
  const code = (await admin.locator('.admin-licence-code').textContent())?.trim() ?? ''
  expect(code).not.toBe('')

  // What the account page hands back, for exactly that box.
  await admin.getByLabel('Licence token').fill(mintLicenceToken(code))
  await admin.getByRole('button', { name: 'Use this token' }).click()
  await expect(admin.locator('.admin-panel > .admin-note')).toContainText('Licence token accepted')

  // Every mark goes, everywhere, and the event can be configured again.
  await expect(admin.locator('.admin-licence-banner')).toHaveCount(0)
  await expect(admin.locator('.admin-licence-status strong')).toHaveText('Licensed')
  await expect(admin.locator('.admin-licence-locked')).toHaveCount(0)
  await expect(crew.locator('.unlicensed-mark')).toHaveCount(0)
})
