import { expect, test } from '@playwright/test'
import {
  cell,
  commitCell,
  createSheet,
  newDevice,
  openPatch,
  openSheetByName,
  uniqueName,
} from './helpers'

test('sheet edits persist across reload and the URL deep-links the sheet', async ({ browser }) => {
  const page = await newDevice(browser)
  await openPatch(page)
  const name = uniqueName('Persist Fest')
  await createSheet(page, name)

  await commitCell(page, 'Artist 1', '1', 'Input', 'Kick')
  await commitCell(page, 'Artist 1', '2', 'Description', 'Snare top')
  await expect(page).toHaveURL(/\/m\/patch\/sheet\//)

  await page.reload()
  // The route restores the same sheet without any navigation.
  await expect(page.locator('table')).toBeVisible()
  await expect(cell(page, 'Artist 1', '1', 'Input')).toHaveValue('Kick')
  await expect(cell(page, 'Artist 1', '2', 'Description')).toHaveValue('Snare top')
})

test('two devices sync a sheet through the box, with crew identity presence', async ({
  browser,
}) => {
  const nameA = `Ava${Date.now().toString(36).slice(-4)}`
  const deviceA = await newDevice(browser, nameA)
  await openPatch(deviceA)
  const sheet = uniqueName('Main Stage')
  await createSheet(deviceA, sheet)
  await commitCell(deviceA, 'Artist 1', '1', 'Input', 'Kick in')

  // Device B: a different crew member finds the sheet via the synced index.
  const deviceB = await newDevice(browser)
  await openPatch(deviceB)
  await openSheetByName(deviceB, sheet)
  await expect(cell(deviceB, 'Artist 1', '1', 'Input')).toHaveValue('Kick in')

  // Edits flow the other way too.
  await commitCell(deviceB, 'Artist 1', '3', 'Mic/DI', 'SM57')
  await expect(cell(deviceA, 'Artist 1', '3', 'Mic/DI')).toHaveValue('SM57')

  // Presence carries the real crew name from the roster, not a self-typed one.
  await cell(deviceA, 'Artist 1', '1', 'Input').click()
  await expect(deviceB.locator('main').locator(`[title="${nameA}"]`).first()).toBeVisible()

  // The status chip reflects the shared room.
  await expect(deviceA.getByText(/Synced · 2 devices/)).toBeVisible()
})

test('undo on one device never reverts the other device’s edit', async ({ browser }) => {
  const deviceA = await newDevice(browser)
  await openPatch(deviceA)
  const sheet = uniqueName('Undo Fest')
  await createSheet(deviceA, sheet)

  const deviceB = await newDevice(browser)
  await openPatch(deviceB)
  await openSheetByName(deviceB, sheet)

  await commitCell(deviceA, 'Artist 1', '1', 'Input', 'A edit')
  await commitCell(deviceB, 'Artist 1', '2', 'Input', 'B edit')
  await expect(cell(deviceA, 'Artist 1', '2', 'Input')).toHaveValue('B edit')
  await expect(cell(deviceB, 'Artist 1', '1', 'Input')).toHaveValue('A edit')

  // A's undo takes back only A's own edit — B's survives on both devices.
  await deviceA.keyboard.press('ControlOrMeta+z')
  await expect(cell(deviceA, 'Artist 1', '1', 'Input')).toHaveValue('')
  await expect(cell(deviceA, 'Artist 1', '2', 'Input')).toHaveValue('B edit')
  await expect(cell(deviceB, 'Artist 1', '1', 'Input')).toHaveValue('')
})

test('pasting a Sheets-style block fills the grid and undoes as one step', async ({ browser }) => {
  const page = await newDevice(browser)
  await openPatch(page)
  await createSheet(page, uniqueName('Paste Fest'))

  await cell(page, 'Artist 1', '1', 'Input').click()
  await page.evaluate(() => {
    const target = document.activeElement as HTMLInputElement
    const data = new DataTransfer()
    data.setData('text/plain', 'Kick\tBeta 91\nSnare\t57\nHat\tKM184')
    target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    )
  })
  await expect(cell(page, 'Artist 1', '1', 'Input')).toHaveValue('Kick')
  await expect(cell(page, 'Artist 1', '2', 'Input')).toHaveValue('Snare')
  await expect(cell(page, 'Artist 1', '3', 'Input')).toHaveValue('Hat')
  await expect(cell(page, 'Artist 1', '2', 'Description')).toHaveValue('57')

  await page.keyboard.press('ControlOrMeta+z')
  await expect(cell(page, 'Artist 1', '1', 'Input')).toHaveValue('')
  await expect(cell(page, 'Artist 1', '3', 'Input')).toHaveValue('')
})

test('sharing a sheet posts a chat link that opens the sheet on another device', async ({
  browser,
}) => {
  const deviceA = await newDevice(browser)
  await openPatch(deviceA)
  const sheet = uniqueName('Share Fest')
  await createSheet(deviceA, sheet)
  await commitCell(deviceA, 'Artist 1', '1', 'Input', 'Kick')

  await deviceA.getByRole('button', { name: 'Share', exact: true }).click()
  await deviceA
    .getByLabel('Share sheet to a channel')
    .getByRole('button', { name: '#general' })
    .click()

  // Device B lands in #general by default, sees the share, and the chip
  // deep-links straight into the patch module.
  const deviceB = await newDevice(browser)
  const shareMsg = deviceB.locator('.msg', { hasText: sheet })
  await expect(shareMsg.first()).toBeVisible()
  await shareMsg.first().getByRole('button', { name: 'Open ↗' }).click()
  await expect(deviceB).toHaveURL(/\/m\/patch\/sheet\//)
  await expect(cell(deviceB, 'Artist 1', '1', 'Input')).toHaveValue('Kick')
})
