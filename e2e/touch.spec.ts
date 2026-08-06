import { expect, test } from '@playwright/test'
import { uniqueName } from './helpers'

/**
 * Touch targets. Platform guidance (iOS 44pt, Android 48dp) wants controls a
 * fingertip can hit reliably; the icon buttons were 28px, and one of them is
 * the hamburger — the single control a phone user cannot do without. On a
 * coarse pointer they grow to 40px visually (with the hit area extended to
 * 48px by a pseudo-element the bounding box cannot see, so 40 is what is
 * asserted here).
 */
test('icon buttons grow to fingertip size on a touch device', async ({ browser }) => {
  // hasTouch flips `pointer: coarse` in Chromium — the media query under test.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(uniqueName('Touch Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  const hamburger = page.getByRole('button', { name: 'Open channels' }).first()
  await expect(hamburger).toBeVisible()
  const box = await hamburger.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(40)
  expect(box!.height).toBeGreaterThanOrEqual(40)

  // And the drawer it opens still works end to end under touch emulation.
  await hamburger.tap()
  const newChannel = page.getByRole('button', { name: 'New channel' })
  await expect(newChannel).toBeVisible()
  const plusBox = await newChannel.boundingBox()
  expect(plusBox!.width).toBeGreaterThanOrEqual(40)
  expect(plusBox!.height).toBeGreaterThanOrEqual(40)

  await context.close()
})
