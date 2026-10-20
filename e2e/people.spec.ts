import { expect, type Page } from '@playwright/test'
import { newDevice, test } from './helpers.ts'

/**
 * Admins as people, and departments, from a browser.
 *
 * The path a real box takes: somebody gets in with the password, makes
 * themselves an admin, adds the departments, and from then on opens the
 * panel with their own PIN. A crew member picks their department, and
 * `@Lighting` reaches them.
 *
 * The box is shared by the whole suite, so this leaves it as it found it:
 * no departments, nobody an admin.
 */

const openAdmin = async (page: Page) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /^Admin/ }).click()
}

test('an admin opens the panel with their own PIN, and @department reaches the department', async ({
  browser,
}) => {
  const lead = await newDevice(browser, 'Lead Admin')
  const ro = await newDevice(browser, 'Rigger Ro')

  // In with the password, then the one step that makes next time a PIN.
  await openAdmin(lead)
  await lead.getByLabel('Admin password').fill('e2e-admin-password')
  await lead.getByRole('button', { name: 'Unlock' }).click()
  await lead.getByRole('button', { name: 'Make me an admin' }).click()
  await expect(lead.getByText(/You’re an admin/)).toBeVisible()
  await expect(lead.getByRole('button', { name: 'Make me an admin' })).toHaveCount(0)

  // The usual departments, in one press.
  await lead.getByRole('button', { name: /^Add Production, Stage, Lighting/ }).click()
  await expect(lead.locator('.admin-department', { hasText: 'Lighting' })).toBeVisible()

  // Locked again, the tab asks for the PIN they sign in with.
  await lead.getByRole('button', { name: 'Lock' }).click()
  await expect(lead.getByLabel('Your PIN')).toBeVisible()
  await lead.getByLabel('Your PIN').fill('0000')
  await lead.getByRole('button', { name: 'Unlock' }).click()
  await expect(lead.getByRole('alert')).toContainText(/not your PIN/i)
  await lead.getByLabel('Your PIN').fill('1234')
  await lead.getByRole('button', { name: 'Unlock' }).click()
  await expect(lead.getByRole('heading', { name: 'Departments' })).toBeVisible()
  await lead.getByRole('button', { name: 'Close settings' }).click()

  // Ro picks Lighting for themselves.
  await ro.getByRole('button', { name: 'Settings', exact: true }).click()
  await ro.getByRole('tab', { name: 'General' }).click()
  await ro.getByRole('combobox', { name: 'Department' }).selectOption({ label: 'Lighting' })
  await expect(ro.getByText(/@Lighting in any channel reaches you/)).toBeVisible()
  await ro.getByRole('button', { name: 'Close settings' }).click()

  // A message to the department is drawn as for Ro.
  await lead.getByPlaceholder(/Message/).fill('@Lighting house to half please')
  await lead.keyboard.press('Enter')
  await expect(
    ro.locator('.msg-body mark.mention-me', { hasText: '@Lighting' }).last()
  ).toBeVisible()

  // Leave the box as it was found.
  await openAdmin(lead)
  for (const name of ['Lighting', 'Production', 'Sound', 'Stage', 'Video']) {
    const row = lead.locator('.admin-department', { hasText: name })
    await row.getByRole('button', { name: 'Delete' }).click()
    await row.getByRole('button', { name: `Delete ${name}?` }).click()
    await expect(row).toHaveCount(0)
  }
  await expect(lead.getByRole('button', { name: /^Add Production/ })).toBeVisible()
  await lead
    .locator('.admin-person', { hasText: 'Lead Admin' })
    .getByRole('button', { name: 'Remove admin' })
    .click()
  // Taking it away from yourself ends your own PIN unlock at once.
  await expect(lead.getByLabel('Admin password')).toBeVisible()
})
