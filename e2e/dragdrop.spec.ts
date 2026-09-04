import { expect, type Page } from '@playwright/test'
import { newDevice, test, uniqueName } from './helpers'

/**
 * Dragging files into the app.
 *
 * Playwright has no real drag from the desktop, so these synthesise the
 * DataTransfer the browser would build. That is enough to exercise the part
 * that actually breaks: whether the drop target lights up for files and not
 * for text, whether every dropped file is taken rather than only the first,
 * and whether the highlight clears afterwards.
 */

/** Build a DataTransfer in the page and hand back a handle to it. */
async function dataTransferWith(page: Page, files: { name: string; mime: string; body: string }[]) {
  return page.evaluateHandle((items) => {
    const dt = new DataTransfer()
    for (const item of items) {
      dt.items.add(new File([item.body], item.name, { type: item.mime }))
    }
    return dt
  }, files)
}

/** A drag carrying text rather than files — must not offer a drop. */
async function textDataTransfer(page: Page) {
  return page.evaluateHandle(() => {
    const dt = new DataTransfer()
    dt.items.add('some dragged words', 'text/plain')
    return dt
  })
}

test('dropping files into a channel shares every one of them', async ({ browser }) => {
  const page = await newDevice(browser, uniqueName('Dropper'))
  const target = page.locator('.message-scroll')

  const one = uniqueName('call-sheet') + '.txt'
  const two = uniqueName('stage-plan') + '.txt'
  const dt = await dataTransferWith(page, [
    { name: one, mime: 'text/plain', body: 'first' },
    { name: two, mime: 'text/plain', body: 'second' },
  ])

  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  // The affordance has to appear, or nobody knows the drop will land.
  await expect(page.getByText('Drop to share')).toBeVisible()

  await target.dispatchEvent('drop', { dataTransfer: dt })

  // Both files, not just the first — the bug this replaced took files[0].
  await expect(page.getByText(one)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(two)).toBeVisible({ timeout: 15_000 })
  // And the highlight goes away once the drop is done.
  await expect(page.getByText('Drop to share')).toBeHidden()

  await page.context().close()
})

test('dragging text over a channel offers nothing to drop', async ({ browser }) => {
  // Selecting a message and dragging it used to light up the drop target,
  // which then did nothing when released and could leave the outline stuck.
  const page = await newDevice(browser, uniqueName('Textdrag'))
  const target = page.locator('.message-scroll')
  const dt = await textDataTransfer(page)

  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  await expect(page.getByText('Drop to share')).toBeHidden()

  await page.context().close()
})

test('the drop outline survives dragging across child elements', async ({ browser }) => {
  // dragleave fires whenever the pointer crosses into a child, so a naive
  // handler drops the highlight while the pointer is still inside the region.
  const page = await newDevice(browser, uniqueName('Childdrag'))
  const target = page.locator('.message-scroll')
  const inner = page.locator('.message-inner')
  const dt = await dataTransferWith(page, [{ name: 'rider.txt', mime: 'text/plain', body: 'x' }])

  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await expect(page.getByText('Drop to share')).toBeVisible()

  // Into a child, and the parent gets a leave for it.
  await inner.dispatchEvent('dragenter', { dataTransfer: dt })
  await target.dispatchEvent('dragleave', { dataTransfer: dt })
  await expect(page.getByText('Drop to share')).toBeVisible()

  await page.context().close()
})

test('dropping a CSV on the patch sheet list imports it', async ({ browser }) => {
  const page = await newDevice(browser, uniqueName('CsvDropper'))
  await page.getByRole('button', { name: 'All sheets…' }).click()
  await expect(page.getByRole('heading', { name: 'Patch Sheets' })).toBeVisible()

  const sheetName = uniqueName('dropped-sheet')
  const csv = ['Channel,Source,Artist 1', '1,Kick,Yes', '2,Snare,Yes'].join('\n')
  const dt = await dataTransferWith(page, [
    { name: `${sheetName}.csv`, mime: 'text/csv', body: csv },
  ])

  // CSS-module class names are hashed, so match the stable part of it — the
  // page root is what carries the drop handlers.
  const target = page.locator('[class*="container"]').first()
  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await expect(page.getByText(/Drop a CSV/)).toBeVisible()
  await target.dispatchEvent('drop', { dataTransfer: dt })

  // Import opens the sheet it just made.
  await expect(page.locator('table')).toBeVisible({ timeout: 10_000 })

  await page.context().close()
})
