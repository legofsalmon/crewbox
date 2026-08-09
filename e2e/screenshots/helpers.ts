import { expect, type Browser, type Page } from '@playwright/test'

/**
 * Helpers for the docs screenshot run. Unlike e2e's `newDevice`, everything
 * here uses FIXED names — these strings appear in published images, so they
 * must be stable, plausible and invented. The crew cast:
 */
export const CREW = {
  sm: 'Maya Quinn (SM)',
  mons: 'Dev Okafor (Mons)',
  lx: 'Lena Brandt (LX)',
  prod: 'Priya Shah (Prod)',
} as const

export const SHOTS_DIR = 'site/docs/img'

/** Join as a named device — a fresh browser context, like a fresh phone. */
export async function fixedDevice(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw error
  })
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  return page
}

/** A phone-sized context for the drawer/phone scenes. */
export async function phoneDevice(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  return page
}

/**
 * Capture one scene in both themes: <scene>-dark.png and <scene>-light.png.
 *
 * The app reads its theme once at startup and then follows the data-theme
 * attribute, so flipping it in-page repaints instantly (every drawing is
 * SVG) and open dialogs survive — no reload, no state loss. The attribute
 * is removed afterwards so the page returns to its boot theme.
 */
export async function shoot(
  page: Page,
  scene: string,
  opts: { clip?: { x: number; y: number; width: number; height: number } } = {}
): Promise<void> {
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await page.waitForTimeout(120)
  await page.screenshot({ path: `${SHOTS_DIR}/${scene}-dark.png`, ...opts })
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))
  await page.waitForTimeout(120)
  await page.screenshot({ path: `${SHOTS_DIR}/${scene}-light.png`, ...opts })
  await page.evaluate(() => delete document.documentElement.dataset.theme)
}
