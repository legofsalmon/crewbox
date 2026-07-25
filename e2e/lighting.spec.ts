import { expect, test, type Page } from '@playwright/test'
import { newDevice, uniqueName } from './helpers'

/**
 * The lighting module through a real box: a plot syncing between two
 * devices, and the DMX collision detection that is the reason the module
 * exists.
 */

const openLighting = async (page: Page) => {
  await page.getByRole('button', { name: 'All plots…' }).click()
  await expect(page.getByRole('heading', { name: 'Lighting Plots' })).toBeVisible()
}

const createPlot = async (page: Page, name: string) => {
  await page.getByRole('button', { name: '+ New Plot' }).click()
  await page.locator('#new-plot-name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Fixtures' })).toBeVisible()
}

/** Add a fixture to the first position group and address it. */
const addFixture = async (
  page: Page,
  { purpose, address, footprint }: { purpose: string; address: number; footprint: number }
) => {
  await page.locator('main').getByRole('button', { name: '+ Fixture' }).first().click()
  const row = page.locator('tbody tr').last()
  await row.getByLabel(/^Purpose/).fill(purpose)
  await row.getByLabel(/^Purpose/).press('Enter')
  await row.getByLabel(/^Footprint/).fill(String(footprint))
  await row.getByLabel(/^Footprint/).press('Enter')
  await row.getByLabel(/^Address/).fill(String(address))
  await row.getByLabel(/^Address/).press('Enter')
}

test('a plot syncs between two devices with crew identity presence', async ({ browser }) => {
  const alice = await newDevice(browser, 'Alice Lighting')
  const bob = await newDevice(browser, 'Bob Lighting')
  const plotName = uniqueName('Main Stage Rig')

  await openLighting(alice)
  await createPlot(alice, plotName)
  await addFixture(alice, { purpose: 'DS Wash SL', address: 1, footprint: 16 })

  // Bob opens the same plot from the synced index, not from a link.
  await openLighting(bob)
  await bob.locator('main').getByText(plotName).first().click()
  await expect(bob.getByRole('tab', { name: 'Fixtures' })).toBeVisible()

  await expect(bob.getByLabel(/^Purpose/).first()).toHaveValue('DS Wash SL')

  // Presence carries the roster name, not a self-assigned one.
  await expect(alice.getByLabel(/Also here: .*Bob Lighting/)).toBeVisible({ timeout: 10_000 })

  // An edit on Bob's device lands on Alice's.
  await bob
    .getByLabel(/^Circuit/)
    .first()
    .fill('A12')
  await bob
    .getByLabel(/^Circuit/)
    .first()
    .press('Enter')
  await expect(alice.getByLabel(/^Circuit/).first()).toHaveValue('A12', { timeout: 10_000 })
})

test('overlapping DMX addresses are flagged on both fixtures', async ({ browser }) => {
  const page = await newDevice(browser, 'Patch Tech')

  await openLighting(page)
  await createPlot(page, uniqueName('Clash Test'))

  // 16 channels from 1 occupies 1–16; 16 channels from 10 occupies 10–25.
  await addFixture(page, { purpose: 'Head 1', address: 1, footprint: 16 })
  await addFixture(page, { purpose: 'Head 2', address: 10, footprint: 16 })

  await expect(page.getByText('2 addressing problems')).toBeVisible()
  await expect(page.getByTestId('fixture-warning')).toHaveCount(2)

  // Moving the second clear of the first resolves both warnings.
  const second = page.locator('tbody tr').last()
  await second.getByLabel(/^Address/).fill('17')
  await second.getByLabel(/^Address/).press('Enter')

  await expect(page.getByTestId('fixture-warning')).toHaveCount(0)
  await expect(page.getByText(/addressing problem/)).toHaveCount(0)
})

test('a phone can always get back to the sidebar from inside a module', async ({ browser }) => {
  // Navigating to a module closes the drawer, and module panes used to have
  // no hamburger — so opening one on a phone stranded you there with no way
  // back to chat or to any other module.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill('Phone Tech')
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  for (const [open, target] of [
    ['All plots…', 'Lighting Plots'],
    ['All sheets…', 'Patch Sheets'],
  ] as const) {
    await page.getByRole('button', { name: 'Open channels' }).first().click()
    await page.getByRole('button', { name: open }).click()
    await expect(page.getByRole('heading', { name: target })).toBeVisible()
    // The selector itself must offer a way back out.
    await expect(page.getByRole('button', { name: 'Open channels' })).toBeVisible()
  }

  // ...and so must a module's inner view. (The loop above finished on the
  // patch selector, so come back to lighting through the drawer.)
  await page.getByRole('button', { name: 'Open channels' }).first().click()
  await page.getByRole('button', { name: 'All plots…' }).click()
  await createPlot(page, uniqueName('Phone Rig'))
  await expect(page.getByRole('button', { name: 'Open channels' })).toBeVisible()
  await page.getByRole('button', { name: 'Open channels' }).click()
  await page.getByRole('button', { name: '#general' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  await context.close()
})

test('a plot survives reload and deep-links back to itself', async ({ browser }) => {
  const page = await newDevice(browser, 'Reload Tech')
  const plotName = uniqueName('Reload Rig')

  await openLighting(page)
  await createPlot(page, plotName)
  await addFixture(page, { purpose: 'Key light', address: 100, footprint: 8 })

  const url = page.url()
  expect(url).toContain('/m/lighting/plot/')

  await page.reload()
  await expect(page.getByLabel(/^Purpose/).first()).toHaveValue('Key light')
})
