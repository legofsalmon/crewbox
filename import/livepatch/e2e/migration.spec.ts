import { expect, test } from '@playwright/test'
import { cell, commitCell, createSheet, newDevice, uniqueName } from './helpers'

const pasteInto = async (page: import('@playwright/test').Page, label: string, tsv: string) => {
  const target = cell(page, 'Artist 1', label.split('|')[0], label.split('|')[1])
  await target.click()
  await target.evaluate((el, text) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    )
  }, tsv)
}

test('pasting a Sheets range fills right and down, undoable in one step', async ({ browser }) => {
  const page = await newDevice(browser)
  await createSheet(page, uniqueName('Paste Fest'))

  // 2 rows × 3 columns starting at channel 1's Input column
  await pasteInto(page, '1|Input', 'Kick\tKick in\tBeta 91A\nSnare\tSnare top\tSM57\n')

  await expect(cell(page, 'Artist 1', '1', 'Input')).toHaveValue('Kick')
  await expect(cell(page, 'Artist 1', '1', 'Description')).toHaveValue('Kick in')
  await expect(cell(page, 'Artist 1', '1', 'Mic/DI')).toHaveValue('Beta 91A')
  await expect(cell(page, 'Artist 1', '2', 'Input')).toHaveValue('Snare')
  await expect(cell(page, 'Artist 1', '2', 'Mic/DI')).toHaveValue('SM57')
  await expect(page.getByText(/Pasted 6 cells/)).toBeVisible()

  // One Ctrl+Z reverts the entire paste
  await page.keyboard.press('Control+z')
  await expect(cell(page, 'Artist 1', '1', 'Input')).toHaveValue('')
  await expect(cell(page, 'Artist 1', '2', 'Mic/DI')).toHaveValue('')
})

test('pasting more rows than channels appends channels', async ({ browser }) => {
  const page = await newDevice(browser)
  await createSheet(page, uniqueName('Tall Paste'))

  const rows = Array.from({ length: 12 }, (_, i) => `Item ${i + 1}`).join('\n')
  await pasteInto(page, '10|Input', rows)

  await expect(page.getByText(/added 11 channel/)).toBeVisible()
  await expect(cell(page, 'Artist 1', '21', 'Input')).toHaveValue('Item 12')
})

test('Ctrl+D fills down from the cell above', async ({ browser }) => {
  const page = await newDevice(browser)
  await createSheet(page, uniqueName('Fill Fest'))

  await commitCell(page, 'Artist 1', '1', 'Mic/DI', 'SM58')
  const below = cell(page, 'Artist 1', '2', 'Mic/DI')
  await below.click()
  await page.keyboard.press('Control+d')
  await expect(below).toHaveValue('SM58')
})

test('arrow keys move between cells Sheets-style', async ({ browser }) => {
  const page = await newDevice(browser)
  await createSheet(page, uniqueName('Arrow Fest'))

  await cell(page, 'Artist 1', '1', 'Input').click()
  await page.keyboard.press('ArrowDown')
  await expect(cell(page, 'Artist 1', '2', 'Input')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(cell(page, 'Artist 1', '2', 'Description')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(cell(page, 'Artist 1', '1', 'Description')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(cell(page, 'Artist 1', '1', 'Input')).toBeFocused()

  // Typing then arrowing away commits the edit, Sheets-style.
  await page.keyboard.type('Kick')
  await page.keyboard.press('ArrowDown')
  await expect(cell(page, 'Artist 1', '1', 'Input')).toHaveValue('Kick')
  await expect(cell(page, 'Artist 1', '2', 'Input')).toBeFocused()
})

test('find highlights matches and Enter jumps to them', async ({ browser }) => {
  const page = await newDevice(browser)
  await createSheet(page, uniqueName('Find Fest'))

  await commitCell(page, 'Artist 1', '1', 'Input', 'Kick drum')
  await commitCell(page, 'Artist 1', '3', 'Description', 'kick sub mix')

  await page.keyboard.press('Control+f')
  await page.getByLabel('Find in sheet').fill('kick')
  await expect(page.getByText('2 matches')).toBeVisible()

  await page.getByLabel('Find in sheet').press('Enter')
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-cell'))
  expect(focused).toContain(':input')
})

test('importing a generic CSV creates a populated sheet', async ({ browser }) => {
  const page = await newDevice(browser)
  const csv = [
    'Ch,Instrument,Mic / DI,Stand,48V',
    '1,Kick,Beta 91A,Short Boom,Yes',
    '2,Snare,SM57,Clip-on,',
  ].join('\n')

  await page.setInputFiles('input[aria-label="Import CSV file"]', {
    name: 'Main Stage Patch.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  })

  await expect(page.locator('table')).toBeVisible()
  await expect(page.locator('#sheet-title')).toHaveValue('Main Stage Patch')
  await expect(page.getByText(/skipped columns: 48V/)).toBeVisible()
  await expect(cell(page, 'Artist 1', '1', 'Input')).toHaveValue('Kick')
  await expect(cell(page, 'Artist 1', '2', 'Mic/DI')).toHaveValue('SM57')
})
