import { expect } from '@playwright/test'
import { appWithDiscovery, scanWillGive, scannerCalls, test, uniqueName } from './helpers'

/**
 * Scanning the join poster, in the apps.
 *
 * The camera, and reading the code it sees, are the phone's (ScannerPlugin on
 * each) and are stood in for: a scan hands back the text a phone would read.
 * That text is the box's own. Its /connect page is the poster, and the QR on
 * it says what the link under it says, so a change to what the box prints
 * that the apps would not take fails here.
 */

const BOX = 'http://localhost:4299'

/** What the box's poster QR says, at the address this suite reaches the box by. */
async function posterCode(): Promise<string> {
  const poster = await (await fetch(`${BOX}/connect`)).text()
  const href = /<p class="url"><a href="([^"]+)">/.exec(poster)?.[1]
  expect(href, 'the link under the QR').toBeDefined()
  const code = new URL(href!.replaceAll('&amp;', '&'))
  // The poster gives the box's address on the crew network, which a test
  // runner may not route to: this is the same box where the suite reaches it.
  code.host = '127.0.0.1:4299'
  return code.href
}

test('the Android app fills in the box and event PIN from the join poster', async ({ browser }) => {
  const page = await appWithDiscovery(browser, 'android', [], {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  await page.goto('/')
  await scanWillGive(page, { result: 'scanned', text: await posterCode() })

  // A thumb's worth of button, on the screen.
  const scan = page.getByRole('button', { name: 'Scan the join poster' })
  const box = (await scan.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await scan.tap()

  await expect(page.getByLabel('Crew server')).toHaveValue('127.0.0.1:4299')
  await expect(page.getByLabel('Event PIN')).toHaveValue('4242')
  await expect(
    page.getByText('Filled in 127.0.0.1:4299 and the event PIN from the poster.')
  ).toBeVisible()
  await expect(page.getByLabel('Your name')).toBeFocused()

  // Nothing else to type but who this is.
  await page.getByLabel('Your name').fill(uniqueName('Poster Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join', exact: true }).tap()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  expect(await scannerCalls(page)).toEqual(['scan'])
})

test('the iPhone app says what else it read, and where the camera is switched back on', async ({
  browser,
}) => {
  const page = await appWithDiscovery(browser, 'ios', [])
  await page.goto('/')
  await scanWillGive(
    page,
    // The Wi-Fi poster, which is often on the same wall.
    { result: 'scanned', text: 'WIFI:T:WPA;S:Crew Net;P:backstage;;' },
    { result: 'denied' }
  )
  const scan = page.getByRole('button', { name: 'Scan the join poster' })

  await scan.click()
  await expect(page.locator('.join-error')).toHaveText(
    'That code is for the Wi-Fi, Crew Net. Join it with this phone’s camera or its Wi-Fi ' +
      'settings, then scan the crew code on the join poster.'
  )
  await expect(page.getByLabel('Crew server')).toHaveValue('')

  await scan.click()
  await expect(page.locator('.join-error')).toContainText(
    'Switch on Camera for Crewbox in Settings'
  )
  await page.getByRole('button', { name: 'Open Settings', exact: true }).click()
  expect(await scannerCalls(page)).toEqual(['scan', 'scan', 'openSettings'])
})
