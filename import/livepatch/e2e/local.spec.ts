import { expect, test } from '@playwright/test'
import { cell, commitCell, createSheet, newDevice, uniqueName } from './helpers'

test('sheet data survives a reload via IndexedDB', async ({ browser }) => {
  const page = await newDevice(browser)
  const name = uniqueName('Persist Fest')
  await createSheet(page, name)

  await commitCell(page, 'Artist 1', '1', 'Input', 'Vocals')
  await commitCell(page, 'Artist 1', '2', 'Mic/DI', 'SM58')

  // Rename channel 1 and define + reference a sub-box
  const label = page.getByLabel('Channel 1 name')
  await label.click()
  await label.fill('Kick')
  await label.press('Enter')

  await page.getByRole('button', { name: 'Sub-Boxes' }).click()
  await page.getByRole('button', { name: '+ Add Sub-Box' }).click()
  const sbName = page.getByLabel('Sub-box name')
  await sbName.fill('Box A')
  await sbName.press('Enter')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await commitCell(page, 'Artist 1', 'Kick', 'Sub-box', 'Box A')
  await expect(cell(page, 'Artist 1', 'Kick', 'Sub-box')).toHaveValue('Box A (MSC)')

  await page.waitForTimeout(600) // let IndexedDB flush
  await page.reload()
  await expect(page.locator('table')).toBeVisible()

  await expect(page.locator('#sheet-title')).toHaveValue(name)
  await expect(cell(page, 'Artist 1', 'Kick', 'Input')).toHaveValue('Vocals')
  await expect(cell(page, 'Artist 1', '2', 'Mic/DI')).toHaveValue('SM58')
  await expect(cell(page, 'Artist 1', 'Kick', 'Sub-box')).toHaveValue('Box A (MSC)')
})

test('the /connect page serves a QR code pointing at the box', async ({ browser }) => {
  const page = await newDevice(browser)
  const response = await page.request.get('/connect')
  expect(response.status()).toBe(200)
  const body = await response.text()
  expect(body).toContain('<svg')
  expect(body).toContain('Open Live Patch on this machine')
})

test('CSV export downloads a file named after the sheet', async ({ browser }) => {
  const page = await newDevice(browser)
  await createSheet(page, uniqueName('Export Fest'))
  await commitCell(page, 'Artist 1', '1', 'Input', 'Drums')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^Export_Fest.*\.csv$/)
})
