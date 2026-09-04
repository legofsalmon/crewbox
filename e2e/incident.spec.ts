import { expect } from '@playwright/test'
import { newDevice, test } from './helpers'

/**
 * The show log, on two real devices through a real box.
 *
 * The unit tests cover the arithmetic and the SQL; what only this layer can
 * prove is the thing the module exists for — a stage manager files an entry
 * and everyone else's phone has it, without either of them being in any
 * particular channel.
 */

const openLog = async (page: import('@playwright/test').Page) => {
  await page
    .getByRole('button', { name: /Show log/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'Show log' })).toBeVisible()
}

test('an entry filed on one phone is on every other phone', async ({ browser }) => {
  const sm = await newDevice(browser, 'Log SM')
  const lx = await newDevice(browser, 'Log LX')

  await openLog(sm)
  await sm.getByRole('button', { name: 'Log an entry' }).click()
  await sm.getByLabel('What happened').fill('Show stopped — wind reading over limit')
  await sm.getByLabel('Kind', { exact: true }).selectOption('show-stop')
  await sm.getByLabel('How bad', { exact: true }).selectOption('serious')
  await sm.getByRole('button', { name: 'Log it' }).click()

  // The author sees it without a reload...
  await expect(sm.getByText('Show stopped — wind reading over limit')).toBeVisible()
  // ...and so does a device that was never told to look.
  await openLog(lx)
  await expect(lx.getByText('Show stopped — wind reading over limit')).toBeVisible()
  await expect(lx.getByText('Log SM', { exact: false }).first()).toBeVisible()
})

test('a mistake is corrected underneath, and both stay', async ({ browser }) => {
  const page = await newDevice(browser, 'Log Fixer')
  await openLog(page)

  await page.getByRole('button', { name: 'Log an entry' }).click()
  await page.getByLabel('What happened').fill('Barrier moved at 21:04')
  await page.getByRole('button', { name: 'Log it' }).click()
  await expect(page.getByText('Barrier moved at 21:04')).toBeVisible()

  await page.getByRole('button', { name: 'Add a correction' }).first().click()
  await page.getByLabel('What happened').fill('Correction: it was 21:14')
  await page.getByRole('button', { name: 'File the correction' }).click()

  // Both, in that order. Nothing in this module removes a line.
  await expect(page.getByText('Barrier moved at 21:04')).toBeVisible()
  await expect(page.getByText('Correction: it was 21:14')).toBeVisible()
})

test('the log says when something was written up later than it happened', async ({ browser }) => {
  const page = await newDevice(browser, 'Log Late')
  await openLog(page)

  await page.getByRole('button', { name: 'Log an entry' }).click()
  await page.getByLabel('What happened').fill('Wrote this one up after the fact')
  await page.getByRole('button', { name: '30 min ago' }).click()
  await page.getByRole('button', { name: 'Log it' }).click()

  // The gap between the thing and the typing is part of the record, so it is
  // on screen rather than only in the database.
  await expect(page.getByText(/logged 30 min later/)).toBeVisible()
})

test('the show log pane carries the shell drawer on a phone', async ({ browser }) => {
  // Same guard as the other modules: navigating to a module closes the
  // drawer, so a pane without a way back strands a phone user inside it.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill('Log Phone')
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  await page.getByRole('button', { name: 'Open channels' }).first().click()
  await openLog(page)
  await expect(page.getByRole('button', { name: 'Open channels' })).toBeVisible()
  await page.getByRole('button', { name: 'Open channels' }).click()
  await expect(page.getByRole('button', { name: '#general' })).toBeVisible()
  await context.close()
})
