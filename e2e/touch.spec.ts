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

/**
 * The closed drawer left a grey band down the left of the screen.
 *
 * It waits just off the left edge, and its shadow reached 40px back onto the
 * screen from there, in both themes and plain to see in the light one. The
 * shadow belongs to the drawer only while it is open.
 */
test('the closed drawer leaves nothing on the screen', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    colorScheme: 'light',
  })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(uniqueName('Edge Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  const shadow = () => page.locator('.sidebar').evaluate((el) => getComputedStyle(el).boxShadow)
  expect(await shadow()).toBe('none')

  // Open, it still stands out from the page behind it.
  await page.getByRole('button', { name: 'Open channels' }).first().tap()
  await expect(page.getByRole('button', { name: '#general' })).toBeVisible()
  await expect.poll(shadow).not.toBe('none')

  await context.close()
})

/**
 * The patch sheet's + and − on a phone.
 *
 * They were shown on hover, which a finger cannot do, so on a phone they were
 * invisible until a channel's name was being typed in, and then 19 by 17
 * pixels, one on top of the other. They are always there on a touch screen
 * now, side by side and the height of the row, and the channel column gives
 * up the room for them rather than taking more of a 390-pixel screen.
 */
test('a phone can insert and remove a patch channel', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(uniqueName('Patch Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  await page.getByRole('button', { name: 'Open channels' }).first().tap()
  await page.getByRole('button', { name: 'All sheets…' }).tap()
  await page.getByRole('button', { name: '+ New Sheet' }).tap()
  await page.locator('#new-sheet-name').fill(uniqueName('Phone Fest'))
  await page.getByRole('button', { name: 'Create', exact: true }).tap()
  await expect(page.locator('table')).toBeVisible()

  const rows = page.locator('tbody th[scope="row"]')
  await expect(rows).toHaveCount(10)
  const house = (channel: number) => page.getByLabel(`Input on channel ${channel}`, { exact: true })
  for (const [channel, input] of [
    [3, 'Kick In'],
    [4, 'ACOUSTIC GTR'],
  ] as const) {
    await house(channel).fill(input)
    await house(channel).press('Enter')
  }

  // Seen without hovering, and big enough for a thumb. Opacity is read
  // directly: Playwright counts an element at opacity 0 as visible.
  const insert = page.getByRole('button', { name: 'Insert channel below 3', exact: true })
  const shown = (locator: typeof insert) =>
    locator.evaluate((el) => getComputedStyle(el.parentElement!).opacity)
  expect(await shown(insert)).toBe('1')
  const size = await insert.evaluate((el) => {
    const style = getComputedStyle(el)
    return { width: parseFloat(style.width), height: parseFloat(style.height) }
  })
  expect(size.width).toBeGreaterThanOrEqual(32)
  expect(size.height).toBeGreaterThanOrEqual(34)
  // The column that stays put while the acts scroll past it was 272 pixels,
  // and a dozen capitals still read whole in it.
  const column = await rows.first().evaluate((el) => el.getBoundingClientRect().width)
  expect(column).toBeLessThanOrEqual(240)
  expect(await house(4).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

  await insert.tap()
  await expect(rows).toHaveCount(11)
  await expect(house(3)).toHaveValue('Kick In')
  await expect(house(4)).toHaveValue('')
  await expect(house(5)).toHaveValue('ACOUSTIC GTR')

  // An empty channel goes without a confirmation.
  const remove = page.getByRole('button', { name: 'Remove channel 4', exact: true })
  expect(await shown(remove)).toBe('1')
  await remove.tap()
  await expect(rows).toHaveCount(10)
  await expect(house(4)).toHaveValue('ACOUSTIC GTR')

  await context.close()
})

/** A computer keeps the tidy grid: the buttons wait for the mouse. */
test('a computer still shows the patch channel buttons on hover only', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(uniqueName('Desk Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  await page.getByRole('button', { name: 'All sheets…' }).click()
  await page.getByRole('button', { name: '+ New Sheet' }).click()
  await page.locator('#new-sheet-name').fill(uniqueName('Desk Fest'))
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('table')).toBeVisible()

  const insert = page.getByRole('button', { name: 'Insert channel below 3', exact: true })
  const shown = () => insert.evaluate((el) => getComputedStyle(el.parentElement!).opacity)
  await expect.poll(shown).toBe('0')
  await page.locator('tbody th[scope="row"]').nth(2).hover()
  await expect.poll(shown).toBe('1')
  // And the house input keeps the width a laptop has room for.
  const width = await page
    .getByLabel('Input on channel 3', { exact: true })
    .evaluate((el) => el.getBoundingClientRect().width)
  expect(width).toBeGreaterThan(150)

  await context.close()
})
