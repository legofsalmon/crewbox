import { expect, test } from '@playwright/test'

/**
 * The published docs site. Everything here is static except docs.js, so
 * these cover exactly what that file does: expand a screenshot, and find a
 * page by searching.
 *
 * The lighting views page is the subject because it carries three
 * screenshots including a phone-shaped one.
 */

test('a screenshot expands into the lightbox and closes again', async ({ page }) => {
  await page.goto('/docs/lighting-views')

  const first = page.getByRole('button', { name: /^Expand:/ }).first()
  await expect(first).toBeVisible()

  const inline = first.locator('img')
  const shown = await inline.evaluate((img: HTMLImageElement) => img.currentSrc)

  await first.click()
  const box = page.locator('dialog.lightbox')
  await expect(box).toBeVisible()

  // The expanded image is the same source the page was already showing —
  // which is how a light-theme reader gets the light capture.
  await expect(box.locator('img')).toHaveJSProperty('currentSrc', shown)
  await expect(box).toContainText('Esc to close')

  await page.keyboard.press('Escape')
  await expect(box).toBeHidden()
})

test('the lightbox opens from the keyboard and toggles actual size', async ({ page }) => {
  await page.goto('/docs/lighting-views')

  // Focus the first expand button without touching the mouse.
  await page
    .getByRole('button', { name: /^Expand:/ })
    .first()
    .focus()
  await page.keyboard.press('Enter')

  const box = page.locator('dialog.lightbox')
  const image = box.locator('img')
  await expect(box).toBeVisible()
  await expect(image).not.toHaveClass(/actual/)

  await image.click()
  await expect(image).toHaveClass(/actual/)
  await expect(box).toContainText('Click to fit')

  await image.click()
  await expect(image).not.toHaveClass(/actual/)

  await box.getByRole('button', { name: 'Close' }).click()
  await expect(box).toBeHidden()
})

test('every page still works without expanding anything: search finds a heading', async ({
  page,
}) => {
  await page.goto('/docs')

  await page.getByLabel('Search the docs').fill('changeover')
  const results = page.locator('.search .results a')
  await expect(results.first()).toBeVisible()
  await expect(results.first()).toContainText(/Patch|Stage|lineup/i)

  await results.first().click()
  await expect(page).toHaveURL(/\/docs\/patch/)
})
