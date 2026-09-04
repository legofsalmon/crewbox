import { expect, test, type Page } from '@playwright/test'
import { newDevice } from './helpers.ts'

/**
 * Updating the box, from a browser.
 *
 * The e2e box runs from source, so it can never install anything — and that is
 * the case worth pinning, because it is also what a developer sees every day.
 * A panel offering a button that could only ever fail would be worse than one
 * offering nothing, and a panel nagging about it on every dev box would be
 * noise on the screen where noise costs the most.
 *
 * The install path itself cannot be driven from a browser without swapping a
 * real binary and restarting a real box. That lives in the server tests, and
 * ultimately in one afternoon on real hardware.
 */

test.describe.configure({ mode: 'serial' })

const unlock = async (page: Page) => {
  await page.getByRole('button', { name: 'Admin panel' }).click()
  await page.getByLabel('Admin password').fill('e2e-admin-password')
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByRole('heading', { name: 'Crew' })).toBeVisible()
}

test('a box that cannot update itself offers no button to try', async ({ browser }) => {
  const admin = await newDevice(browser, 'Update Admin')
  await unlock(admin)

  // The panel is up and populated — the Version row proves the section it
  // would sit beside rendered.
  await expect(admin.getByText('Version', { exact: true })).toBeVisible()

  // And the updater section renders nothing at all — not an empty box, not a
  // disabled button, not a nag. (Scoped by container rather than by button
  // text: the panel already has an unrelated "Download the dnsmasq config".)
  await expect(admin.locator('.admin-updater')).toHaveCount(0)
  await expect(admin.getByRole('button', { name: /Install and restart/ })).toHaveCount(0)

  await admin.context().close()
})

test('the tray link opens the panel and then gets out of the address bar', async ({ browser }) => {
  // The tray and menu-bar helpers know a URL and nothing else about the app,
  // so `?admin` is the whole interface between them. It used to open a GitHub
  // download page, which stopped being the right answer the moment the box
  // could update itself.
  const admin = await newDevice(browser, 'Tray Admin')
  await admin.goto('/?admin')

  // Straight to the panel's door — the password still gates it, because a
  // link is not an unlock.
  await expect(admin.getByLabel('Admin password')).toBeVisible()

  // And the parameter is gone, so a reload does not reopen a panel somebody
  // deliberately closed.
  //
  // Asserted as "no ?admin" rather than "the URL is exactly /": the welcome
  // navigates to the landing channel a moment later, so racing that was a
  // flake that only appeared under load — and the URL being `/c/<id>` is not
  // a failure of anything this test is about.
  await expect(admin).not.toHaveURL(/[?&]admin\b/)

  await admin.context().close()
})
