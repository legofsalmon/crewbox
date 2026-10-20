import { expect } from '@playwright/test'
import { FakeConsole } from './dmxSender'
import { textContrast } from './contrast'
import { newDevice, test } from './helpers'

/**
 * The network map. The e2e box listens to sACN on loopback, so a console
 * sending to itself is the one device it can honestly be expected to place;
 * the crew network is the machine's own, and is only ever a count.
 */

test('the map places a console on the lighting network for any crew member', async ({
  browser,
}) => {
  const console_ = new FakeConsole()
  await console_.start(1, { 1: 255 })
  try {
    const page = await newDevice(browser)
    await page.getByRole('button', { name: 'Open network map' }).click()
    await expect(page.getByRole('heading', { name: 'Network map' })).toBeVisible()
    await expect(page).toHaveURL(/\/m\/network\/map$/)

    // It says what it is before anything else: never the whole network.
    await expect(page.getByText(/never the whole network/)).toBeVisible()

    const crew = page.getByRole('region', { name: 'Crew network' })
    await expect(crew).toBeVisible()
    await expect(crew.getByText(/counted, never listed/)).toBeVisible()

    const lighting = page.getByRole('region', { name: 'Lighting network' })
    await expect(lighting.getByText('Test Console')).toBeVisible({ timeout: 15_000 })
    await expect(lighting.getByText('Heard').first()).toBeVisible()

    // The video lane is there because the module is, and lists what was named.
    await expect(page.getByRole('region', { name: 'Video network' })).toBeVisible()

    // Back to the audit from the sidebar.
    await page.getByRole('button', { name: 'Open network audit' }).click()
    await expect(page.getByRole('heading', { name: 'Network', exact: true })).toBeVisible()
  } finally {
    console_.stop()
  }
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the map stays readable in ${scheme} theme`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme })
    const page = await context.newPage()
    page.on('pageerror', (e) => {
      throw new Error(`Page error: ${e.message}`)
    })
    await page.goto('/?pin=4242')
    await page.getByLabel('Your name').fill(`Map ${scheme}`)
    await page.getByLabel('Your PIN').fill('1234')
    await page.getByRole('button', { name: 'Join' }).click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()

    await page.getByRole('button', { name: 'Open network map' }).click()
    await expect(page.getByText(/never the whole network/)).toBeVisible()
    expect(await textContrast(page, 'h1')).toBeGreaterThan(4.5)
    expect(await textContrast(page, 'text=/never the whole network/')).toBeGreaterThan(4.5)
    expect(await textContrast(page, 'text=/counted, never listed/')).toBeGreaterThan(4.5)
    await context.close()
  })
}
