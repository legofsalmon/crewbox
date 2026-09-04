import { expect } from '@playwright/test'
import { newDevice, test } from './helpers'

/**
 * The network audit pane. The e2e box listens to sACN on loopback and does
 * not run the media watchers, so the honest expectations are: crew card
 * present with live counts, lighting card graded from the loopback
 * listener, media card saying "Not watched" — degradation is part of the
 * product, so it is part of the test.
 */

test('the audit pane grades the three networks for any crew member', async ({ browser }) => {
  const page = await newDevice(browser)
  await page.getByRole('button', { name: 'Open network audit' }).click()

  await expect(page.getByRole('heading', { name: 'Network', exact: true })).toBeVisible()

  // Three cards, always — a network the box can't see says so rather than
  // disappearing.
  const crew = page.getByRole('region', { name: 'Crew network' })
  await expect(crew).toBeVisible()
  await expect(crew.getByText(/connection/)).toBeVisible()

  const lighting = page.getByRole('region', { name: 'Lighting network' })
  await expect(lighting).toBeVisible()

  const media = page.getByRole('region', { name: 'Audio & media network' })
  await expect(media).toBeVisible()
  await expect(media.getByText('Not watched')).toBeVisible()
  // The unwatched card carries the fix, not a fake verdict.
  await expect(media.getByText(/CREWBOX_WATCH/)).toBeVisible()

  // The event strip renders (quiet is a valid, stated answer).
  await expect(page.getByRole('region', { name: 'Events, last 24 hours' })).toBeVisible()

  // The report downloads as one self-contained HTML file.
  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download HTML report' }).click(),
  ]).then(([d]) => d)
  expect(download.suggestedFilename()).toMatch(/^crewbox-network-audit-\d{4}-\d{2}-\d{2}\.html$/)
})

test('a phone can get into and back out of the audit pane', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(`Audit Tech ${Date.now().toString(36)}`)
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  await page.getByRole('button', { name: 'Open channels' }).first().click()
  await page.getByRole('button', { name: 'Open network audit' }).click()
  await expect(page.getByRole('heading', { name: 'Network', exact: true })).toBeVisible()

  // The drawer button is there — the phone user is never stranded.
  await page.getByRole('button', { name: 'Open channels' }).click()
  await page.getByRole('button', { name: '#general' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  await context.close()
})
