import { expect } from '@playwright/test'
import { test, uniqueName } from './helpers'

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

  // Computed style, not boundingBox: with isMobile emulation the page can be
  // auto-zoomed out a few percent to fit content (long messages left by
  // earlier specs against the shared server), and boundingBox reports the
  // visually scaled size. The property under test is the CSS size the media
  // query sets, which computed style reads unscaled.
  const cssSize = (locator: ReturnType<typeof page.getByRole>) =>
    locator.evaluate((el) => {
      const style = getComputedStyle(el)
      return { width: parseFloat(style.width), height: parseFloat(style.height) }
    })

  const hamburger = page.getByRole('button', { name: 'Open channels' }).first()
  await expect(hamburger).toBeVisible()
  const box = await cssSize(hamburger)
  expect(box.width).toBeGreaterThanOrEqual(40)
  expect(box.height).toBeGreaterThanOrEqual(40)

  // And the drawer it opens still works end to end under touch emulation.
  await hamburger.tap()
  const newChannel = page.getByRole('button', { name: 'New channel' })
  await expect(newChannel).toBeVisible()
  const plusBox = await cssSize(newChannel)
  expect(plusBox.width).toBeGreaterThanOrEqual(40)
  expect(plusBox.height).toBeGreaterThanOrEqual(40)

  await context.close()
})

/**
 * Tapping a channel must not throw up the soft keyboard.
 *
 * The composer focused itself on every channel change. On a keyboard that
 * costs nothing and saves a click; on a phone it opens the keyboard, so a
 * crew member who tapped #stage in the drawer to read what was posted
 * arrived to the messages they wanted pushed off the top of the screen by a
 * keyboard they had not asked for — and had to dismiss it before they could
 * see anything. Reading is what most channel taps are for.
 */
test('tapping a channel does not open the keyboard on a phone', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(uniqueName('Phone Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()

  const composer = page.getByPlaceholder(/Message/)
  await expect(composer).toBeVisible()
  // Arriving at the first channel is a channel change like any other.
  await expect(composer).not.toBeFocused()

  // And so is a tap in the drawer. #general is always there.
  await page.getByRole('button', { name: 'Open channels' }).first().tap()
  await page.getByRole('button', { name: '#general' }).tap()
  await expect(composer).toBeVisible()
  await expect(composer).not.toBeFocused()

  // Tapping the box itself still focuses it — that is a request to type.
  await composer.tap()
  await expect(composer).toBeFocused()

  await context.close()
})
