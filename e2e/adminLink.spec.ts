import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { newDevice, test, uniqueName } from './helpers.ts'

/**
 * "Open the admin panel" in the box's menu, and `crewbox --admin`.
 *
 * Both open the link the box keeps in admin-link.json, in its data directory
 * (server/src/adminLink.ts): a key that unlocks the panel once, for whoever
 * can read that file. So a lost admin password stops being a restart with an
 * environment variable, on a Mac box that has no console to have printed it.
 *
 * These open it the way the menu does: read the file, open the URL in a
 * browser on the box.
 */

const DATA_DIR = process.env.CREWBOX_E2E_DATA_DIR ?? ''

/** The link the menu would open right now. */
const menuLink = () =>
  (JSON.parse(readFileSync(join(DATA_DIR, 'admin-link.json'), 'utf8')) as { url: string }).url

test.describe.configure({ mode: 'serial' })

test('opens the panel unlocked, once', async ({ browser }) => {
  const operator = await newDevice(browser, uniqueName('Box Operator'))
  const link = menuLink()
  // The key rides in the fragment, which a browser never sends: nothing on
  // the way logs it.
  expect(link).toMatch(/^http:\/\/localhost:4299\/\?admin#admin-key=[\w-]{43}$/)

  await operator.goto(link)
  await expect(operator.getByRole('heading', { name: 'Crew' })).toBeVisible()
  // Out of the address bar, so a copied address or a reload carries nothing.
  expect(operator.url()).not.toContain('admin-key')
  expect(operator.url()).not.toContain('admin')

  // Spent. The same link again gets the password box, saying why, rather
  // than a panel that silently will not open.
  await operator.goto(link)
  await expect(operator.getByLabel('Admin password')).toBeVisible()
  await expect(operator.getByText(/already been used/)).toBeVisible()

  // The menu reads the file each time, and the file already has the next.
  const next = menuLink()
  expect(next).not.toBe(link)
  await operator.goto(next)
  await expect(operator.getByRole('heading', { name: 'Crew' })).toBeVisible()
})

/**
 * The box's own browser is often one nobody joined from: the operator set
 * the event up there, then joined on their phone. The link has to survive
 * the join form, and its key must not wait for it.
 */
test('works from a browser that has not joined yet', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const link = menuLink()

  await page.goto(link)
  await expect(page.getByLabel('Your name')).toBeVisible()
  // Spent before anybody has typed a thing, so the history this browser
  // keeps holds a dead key.
  await expect.poll(menuLink).not.toBe(link)
  expect(page.url()).not.toContain('admin-key')

  await page.getByLabel('Your name').fill(uniqueName('Box Browser'))
  await page.getByLabel('Event PIN').fill('4242')
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByRole('heading', { name: 'Crew' })).toBeVisible()

  await context.close()
})
