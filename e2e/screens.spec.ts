import { expect, type Page } from '@playwright/test'
import { newDevice, test } from './helpers'

/**
 * Screen maps, through a real box.
 *
 * The unit tests cover reading the file and the checks. What only this
 * layer shows is the reason the pane exists: a preset imported on the
 * video op's laptop is on every phone on the box a moment later, opening
 * from the sidebar with the same slices and the same warnings.
 */

const FIXTURE = 'web/src/modules/video/model/__fixtures__/screen-setup.xml'

const openScreenMaps = async (page: Page) => {
  await page.getByRole('button', { name: 'All screen maps…' }).click()
  await expect(page.getByRole('heading', { name: 'Screen maps' })).toBeVisible()
}

test('a preset imported on one device opens on another', async ({ browser }) => {
  const laptop = await newDevice(browser, 'Video Op')
  await openScreenMaps(laptop)

  // The file is read on the laptop; the box only ever sees the document.
  await laptop.getByLabel('Import Advanced Output XML').setInputFiles(FIXTURE)
  await expect(laptop.getByRole('heading', { name: 'Fixture Stage' })).toBeVisible()
  await expect(laptop.getByText('Composition 1920 × 1080 · 2 screens · 7 slices')).toBeVisible()

  // The checks an LED tech would otherwise do by eye, on the summary line.
  await expect(laptop.getByText('5 with gaps')).toBeVisible()
  await expect(laptop.getByText('2 overlapping')).toBeVisible()
  await expect(laptop.getByText('1 sub-pixel')).toBeVisible()

  // Pinning a slice says what the checks found, in words.
  await laptop.getByRole('button', { name: /^RIGHT BOTTOM/ }).click()
  const details = laptop.getByRole('region', { name: 'Slice RIGHT BOTTOM' })
  await expect(details).toBeVisible()
  await expect(details.getByText('3 px gap to “RIGHT TOP” (above)')).toBeVisible()
  await expect(
    details.getByText('output not on whole pixels (1440.5, 543 · 479.5×537)')
  ).toBeVisible()

  // A phone that never saw the file lists the map and opens it.
  const phone = await newDevice(browser, 'Screens Tech')
  const row = phone.getByRole('button', { name: /^Open screen map Fixture Stage/ })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await expect(phone.getByRole('heading', { name: 'Fixture Stage' })).toBeVisible()
  await expect(phone.getByRole('region', { name: 'Screen LED' })).toBeVisible()
  await expect(phone.getByRole('button', { name: /^CENTER/ })).toBeVisible()
  await expect(phone.getByText('5 with gaps')).toBeVisible()
})

test('which processor feeds a screen is shared, and the map says when nothing is listed', async ({
  browser,
}) => {
  const laptop = await newDevice(browser, 'Video Op Two')
  await openScreenMaps(laptop)
  await laptop.getByLabel('Import Advanced Output XML').setInputFiles(FIXTURE)
  await expect(laptop.getByRole('heading', { name: 'Fixture Stage' })).toBeVisible()

  // The feed control is there for every screen. Whether it has anything to
  // offer depends on the LED pane: with no processor added on this box it
  // says so instead of presenting an empty menu.
  const feed = laptop.getByLabel('Processor input feeding LED')
  await expect(feed).toBeVisible()
  await expect(feed.locator('option').first()).toHaveText(/no processors listed|not mapped/)
})

test('the LED walls pane is still where it was', async ({ browser }) => {
  const page = await newDevice(browser, 'Video Regression')
  await page
    .getByRole('button', { name: /LED walls/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'LED walls' })).toBeVisible()
  await expect(page.getByText('crewbox reads LED processors and cannot control them')).toBeVisible()
})
