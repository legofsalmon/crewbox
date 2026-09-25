import { expect } from '@playwright/test'
import {
  appWithDiscovery,
  scanWillGive,
  scannerCalls,
  test,
  uniqueName,
  wifiCalls,
  wifiWillGive,
  type WifiOutcome,
} from './helpers'

/**
 * Scanning the join poster, in the apps.
 *
 * The camera, and reading the code it sees, are the phone's (ScannerPlugin on
 * each) and are stood in for: a scan hands back the text a phone would read.
 * That text is the box's own. Its /connect page is the poster, and the QR on
 * it says what the link under it says, so a change to what the box prints
 * that the apps would not take fails here. The poster names the event and its
 * key, so every join from it here is checked against the box first, as on
 * site. Joining a network from a Wi-Fi code is the phone's too (WifiPlugin),
 * and stood in for the same way.
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

/** A P-256 public key as a box gives one, and not this box's. */
async function anotherKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  return Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
}

test('the Android app sends nothing to a box that isn’t the one on the poster', async ({
  browser,
}) => {
  const page = await appWithDiscovery(browser, 'android', [])
  await page.goto('/')
  // This box's poster, with another box's key: what a phone on the wrong
  // Wi-Fi meets, where something else has the poster's address.
  const code = new URL(await posterCode())
  code.searchParams.set('key', await anotherKey())
  await scanWillGive(page, { result: 'scanned', text: code.href })
  const joins: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/join') joins.push(request.url())
  })

  await page.getByRole('button', { name: 'Scan the join poster' }).click()
  await expect(page.getByLabel('Event PIN')).toHaveValue('4242')
  await page.getByLabel('Your name').fill(uniqueName('Wrong Wi-Fi Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join', exact: true }).click()

  await expect(page.locator('.join-error')).toHaveText(
    'The box at 127.0.0.1:4299 isn’t the one on this poster, so nothing has gone to it. ' +
      'Check the phone is on the event’s Wi-Fi, then try again, or ask whether the poster is ' +
      'current.'
  )
  expect(joins).toEqual([])
})

test('the iPhone app says what else it read, and where the camera is switched back on', async ({
  browser,
}) => {
  const page = await appWithDiscovery(browser, 'ios', [])
  await page.goto('/')
  await scanWillGive(
    page,
    // The venue's own staff network, whose code may be on the same wall.
    { result: 'scanned', text: 'WIFI:T:WPA2-EAP;S:Venue Staff;E:PEAP;I:crew;P:password;;' },
    { result: 'denied' }
  )
  const scan = page.getByRole('button', { name: 'Scan the join poster' })

  await scan.click()
  await expect(page.locator('.join-error')).toHaveText(
    'That code is for the Wi-Fi, Venue Staff, which the app can’t join. Join it in the ' +
      'phone’s Wi-Fi settings, then scan the crew code on the join poster.'
  )
  await expect(page.getByLabel('Crew server')).toHaveValue('')
  expect(await wifiCalls(page)).toEqual([])

  await scan.click()
  await expect(page.locator('.join-error')).toContainText(
    'Switch on Camera for Crewbox in Settings'
  )
  await page.getByRole('button', { name: 'Open Settings', exact: true }).click()
  expect(await scannerCalls(page)).toEqual(['scan', 'scan', 'openSettings'])
})

for (const [platform, app, outcome, said] of [
  ['ios', 'iPhone', 'joined', 'On Crew Net. Now scan the crew code on the join poster.'],
  [
    'android',
    'Android',
    'saved',
    'Saved Crew Net, and the phone is joining it. Now scan the crew code on the join poster.',
  ],
] as const) {
  test(`the ${app} app joins the crew Wi-Fi from its code, then the poster fills in the rest`, async ({
    browser,
  }) => {
    const page = await appWithDiscovery(browser, platform, [])
    await page.goto('/')
    await scanWillGive(
      page,
      // The Wi-Fi's code, often on the same wall, and then the poster's own.
      { result: 'scanned', text: 'WIFI:T:WPA;S:Crew Net;P:backstage;;' },
      { result: 'scanned', text: await posterCode() }
    )
    await wifiWillGive(page, { result: outcome } satisfies WifiOutcome)
    const scan = page.getByRole('button', { name: 'Scan the join poster' })

    await scan.click()
    await expect(page.locator('.join-scan-note')).toHaveText(said)
    await expect(page.locator('.join-error')).toHaveCount(0)
    expect(await wifiCalls(page)).toEqual([
      { ssid: 'Crew Net', password: 'backstage', wpa3: false, hidden: false },
    ])

    await scan.click()
    await expect(page.getByLabel('Crew server')).toHaveValue('127.0.0.1:4299')
    await expect(page.getByLabel('Event PIN')).toHaveValue('4242')
    await page.getByLabel('Your name').fill(uniqueName('Wi-Fi Tech'))
    await page.getByLabel('Your PIN').fill('1234')
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()
    expect(await wifiCalls(page)).toHaveLength(1)
  })
}
