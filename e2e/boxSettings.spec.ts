import { expect, type Page } from '@playwright/test'
import { newDevice, test } from './helpers.ts'

/**
 * Box settings: what used to need an environment variable, chosen in the
 * panel. Asked for by somebody running the box from the Mac menu bar, which
 * has no terminal to set one in.
 *
 * Everything here applies on the next start, so the test saves, sees the
 * panel say so, and puts the setting back — the e2e box is shared by every
 * spec and is never restarted mid-run.
 */

test.describe.configure({ mode: 'serial' })

const unlock = async (page: Page) => {
  await page.getByRole('button', { name: 'Admin panel' }).click()
  await page.getByLabel('Admin password').fill('e2e-admin-password')
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByRole('heading', { name: 'Crew' })).toBeVisible()
}

test('a setting is saved in the panel, and the panel says it waits for a restart', async ({
  browser,
}) => {
  const admin = await newDevice(browser, 'Settings Admin')
  await unlock(admin)
  await expect(admin.getByRole('heading', { name: 'Box settings' })).toBeVisible()

  // The e2e box names its modules in the environment, which outranks the
  // panel: shown, not offered.
  await expect(admin.getByText('Set by CREWBOX_MODULES=', { exact: false })).toBeVisible()
  await expect(admin.getByRole('checkbox', { name: 'Show log' })).toHaveCount(0)

  const save = admin.getByRole('button', { name: 'Save box settings' })
  await expect(save).toBeDisabled()

  await admin.getByLabel('Keep crew signed in for (days)').fill('30')
  await admin.getByLabel('Festival timezone').fill('Europe/Dublin')
  await save.click()
  await expect(admin.getByText('Box settings saved. Restart the box to apply them.')).toBeVisible()
  const form = admin.locator('form', { has: save })
  await expect(
    form.getByText('Saved settings differ from what this box started with', { exact: false })
  ).toBeVisible()
  await expect(save).toBeDisabled()

  // A timezone nobody has heard of is refused, and says which field.
  await admin.getByLabel('Festival timezone').fill('Mars/Olympus')
  await save.click()
  await expect(admin.getByText('That is not a timezone name, like Europe/Dublin.')).toBeVisible()

  // Put it back, so no other spec starts a box with a surprise.
  await admin.getByLabel('Festival timezone').fill('')
  await admin.getByLabel('Keep crew signed in for (days)').fill('')
  await save.click()
  await expect(admin.getByText('Box settings saved.', { exact: true })).toBeVisible()

  await admin.context().close()
})
