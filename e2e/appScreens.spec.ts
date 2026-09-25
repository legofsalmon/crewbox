import { expect, type BrowserContext, type Page } from '@playwright/test'
import { keepScreensInTheApp, screensCalls, test } from './helpers'

/**
 * The screens telling the app they started (web/src/lib/appScreens.ts).
 *
 * In the apps, screens from a box that don't say so soon after they load
 * have failed, and the app goes back to the ones it came with. A page that
 * says it too early vouches for screens that never drew; one that waits for
 * the box sends a phone with no signal back to screens that were fine. So it
 * says so once the first real screen has drawn, once per load, whether or
 * not the box answers.
 */

const contexts: BrowserContext[] = []
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => {})))
})

/** The iPhone app, stood in for as boxes.spec.ts does, with its screens plugin. */
async function app(browser: import('@playwright/test').Browser): Promise<Page> {
  const context = await browser.newContext()
  contexts.push(context)
  await context.addInitScript(() => {
    ;(window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {},
    }
  })
  await context.addInitScript(keepScreensInTheApp)
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`)
  })
  return page
}

test('the screens say they started once the join form has drawn, once per load', async ({
  browser,
}) => {
  const page = await app(browser)
  await page.goto('/')
  await expect(page.getByLabel('Your name')).toBeVisible()
  const version = (await page.locator('.join-version').textContent())!.replace(/^v/, '')
  await expect.poll(() => screensCalls(page)).toEqual([`ready ${version}`])

  // A new load is a new start, which the app counts afresh.
  await page.reload()
  await expect(page.getByLabel('Your name')).toBeVisible()
  await expect.poll(() => screensCalls(page)).toEqual([`ready ${version}`])
})

test('the screens say they started with the box not answering', async ({ browser }) => {
  const page = await app(browser)
  await page.context().route('**/api/**', (route) => route.abort())
  await page.goto('/')
  await expect(page.getByLabel('Your name')).toBeVisible()
  await expect
    .poll(() => screensCalls(page))
    .toEqual([expect.stringMatching(/^ready \d+\.\d+\.\d+/)])
})
