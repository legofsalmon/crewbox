import { expect, type BrowserContext, type Page } from '@playwright/test'
import { textContrast } from './contrast.ts'
import {
  keepScreensInTheApp,
  screensCalls,
  screensSwitches,
  screensWillAnswer,
  test,
} from './helpers'

/**
 * The screens telling the app they started, and the apps following their box
 * (web/src/lib/appScreens.ts).
 *
 * In the apps, screens from a box that don't say so soon after they load
 * have failed, and the app goes back to the ones it came with. A page that
 * says it too early vouches for screens that never drew; one that waits for
 * the box sends a phone with no signal back to screens that were fine. So it
 * says so once the first real screen has drawn, once per load, whether or
 * not the box answers.
 *
 * A box running another build is followed through the app, which has no
 * service worker: the pill switches to the box's own screens once the app
 * has them, and a note says what to update when it can't run them.
 */

const contexts: BrowserContext[] = []
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => {})))
})

/** The iPhone app, stood in for as boxes.spec.ts does, with its screens plugin. */
async function app(
  browser: import('@playwright/test').Browser,
  colorScheme: 'light' | 'dark' = 'light'
): Promise<Page> {
  const context = await browser.newContext({ colorScheme })
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

/** A build of crewbox the suite's box isn't. */
const OTHER = '9.9.9+e2e0001'

/**
 * The suite's box, saying in its welcome that it runs `version`: its socket,
 * with that one message changed on its way to the page.
 */
async function boxRuns(page: Page, version: string): Promise<void> {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer()
    server.onMessage((message) => {
      if (typeof message === 'string' && message.includes('"welcome"')) {
        const msg = JSON.parse(message) as { type?: string }
        if (msg.type === 'welcome') {
          ws.send(JSON.stringify({ ...msg, serverVersion: version }))
          return
        }
      }
      ws.send(message)
    })
  })
}

/** Join the suite's box from the app's join screen. */
async function join(page: Page, name: string): Promise<void> {
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
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

test('in the apps, a box running another build offers its screens once the app has them', async ({
  browser,
}) => {
  const page = await app(browser)
  await boxRuns(page, OTHER)
  await page.goto('/?server=http://localhost:4299&pin=4242')
  await screensWillAnswer(page, { result: 'ready', version: OTHER })
  await join(page, 'Screens Ready')

  const pill = page.getByRole('button', { name: /New version ready/ })
  await expect(pill).toBeVisible()
  expect(await screensCalls(page)).toContain('prepare http://localhost:4299')
  expect(await screensSwitches(page)).toEqual([])

  // The app serves them for the open event, and the page reloads into them
  // where it was.
  const at = page.url()
  await page.evaluate(() => ((window as { beforeSwitch?: boolean }).beforeSwitch = true))
  await pill.click()
  await expect
    .poll(() => page.evaluate(() => (window as { beforeSwitch?: boolean }).beforeSwitch))
    .toBeUndefined()
  expect(await screensSwitches(page)).toEqual([expect.stringMatching(/^use \S+ 9\.9\.9\+e2e0001$/)])
  expect(page.url()).toBe(at)
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
})

for (const scheme of ['light', 'dark'] as const) {
  test(`in the apps, a note says what to update, readable in ${scheme} theme`, async ({
    browser,
  }) => {
    const page = await app(browser, scheme)
    await boxRuns(page, OTHER)
    await page.goto('/?server=http://localhost:4299&pin=4242')
    await screensWillAnswer(page, { result: 'incompatible', version: OTHER, update: 'app' })
    await join(page, `Screens Note ${scheme}`)

    const note = page.locator('.screens-note')
    await expect(note).toContainText(
      'This box runs crewbox 9.9.9, whose screens need a newer app. Update the app to use them.'
    )
    // Nothing a reload would change.
    await expect(page.getByRole('button', { name: /New version/ })).toBeHidden()
    expect(await textContrast(page, '.screens-note span')).toBeGreaterThan(4.5)
    expect(await textContrast(page, '.screens-note-close')).toBeGreaterThan(4.5)

    await note.getByRole('button', { name: 'Dismiss' }).click()
    await expect(note).toBeHidden()
    expect(await screensSwitches(page)).toEqual([])
  })
}

test('in the apps, another event opens on the screens it would start with when its box is away', async ({
  browser,
}) => {
  const page = await app(browser)
  await page.goto('/?server=http://localhost:4299&pin=4242')
  await join(page, 'Screens Switch')
  await page.evaluate(() => {
    const events = JSON.parse(localStorage.getItem('crewbox:boxes') ?? '[]') as unknown[]
    // A box nothing answers at.
    events.push({ id: 'harbour', name: 'Harbour Tour', origin: 'http://127.0.0.1:9', seenAt: 1 })
    localStorage.setItem('crewbox:boxes', JSON.stringify(events))
  })
  // Read at a start, as a phone that knew it before would.
  await page.reload()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  // Nothing answers there, which takes a moment to find out.
  await page.route('http://127.0.0.1:9/**', (route) => {
    setTimeout(() => void route.abort().catch(() => {}), 500)
  })

  await page.getByRole('button', { name: 'Your boxes', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Your boxes' })
    .locator('.boxes-row', { hasText: 'Harbour Tour' })
    .locator('.boxes-pick')
    .click()
  await expect(page.getByText('Opening Harbour Tour…')).toBeVisible()

  // Its join form, on whatever the app serves for it.
  await expect(page.getByLabel('Crew server')).toHaveValue('http://127.0.0.1:9')
  expect(await screensSwitches(page)).toEqual(['use harbour'])
  expect(await page.evaluate(() => localStorage.getItem('crewbox:event'))).toBe('harbour')
})
