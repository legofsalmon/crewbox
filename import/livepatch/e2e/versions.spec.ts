import { expect, test } from '@playwright/test'
import { cell, commitCell, createSheet, newDevice, uniqueName } from './helpers'

test('save, restore, and undo-restore a version', async ({ browser }) => {
  const page = await newDevice(browser)
  page.on('dialog', (dialog) => dialog.accept())
  await createSheet(page, uniqueName('Version Fest'))

  await commitCell(page, 'Artist 1', '1', 'Input', 'Kick')
  await page.getByRole('button', { name: 'Versions' }).click()
  await page.getByLabel('Version name').fill('after soundcheck')
  await page.getByRole('button', { name: 'Save current version' }).click()
  await expect(page.getByText('after soundcheck', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()

  await commitCell(page, 'Artist 1', '1', 'Input', 'Changed later')
  await page.getByRole('button', { name: 'Versions' }).click()
  await page.getByRole('button', { name: 'Restore' }).click()
  await expect(cell(page, 'Artist 1', '1', 'Input')).toHaveValue('Kick')

  // One Ctrl+Z takes the sheet back to how it was before the restore.
  await page.keyboard.press('Control+z')
  await expect(cell(page, 'Artist 1', '1', 'Input')).toHaveValue('Changed later')
})

test('deleting a version removes it from the list', async ({ browser }) => {
  const page = await newDevice(browser)
  page.on('dialog', (dialog) => dialog.accept())
  await createSheet(page, uniqueName('Version Cull'))

  await page.getByRole('button', { name: 'Versions' }).click()
  await page.getByLabel('Version name').fill('doomed')
  await page.getByRole('button', { name: 'Save current version' }).click()
  await page.getByRole('button', { name: 'Delete version doomed' }).click()
  await expect(page.getByText('No versions saved yet.')).toBeVisible()
})
