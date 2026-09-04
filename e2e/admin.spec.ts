import { expect } from '@playwright/test'
import { newDevice, test } from './helpers.ts'

/**
 * First-run setup, on a box nobody has joined yet.
 *
 * This file runs first (alphabetically, and the suite is serial with one
 * worker) because that's the only moment /setup exists — the same reason it
 * is safe to leave unauthenticated. It sets the event name the rest of the
 * suite then runs under, and re-uses the PIN the other specs expect, which
 * doubles as proof that a PIN typed here really does gate joins.
 */

const EVENT_NAME = 'Ashton Court 2026'

test.describe.configure({ mode: 'serial' })

test('setup names the event, then closes behind the first joiner', async ({ page, browser }) => {
  await page.goto('/setup')
  await expect(page.getByLabel('Event name')).toBeVisible()
  // Pre-filled, so an admin who just wants to get going can hit Save.
  await expect(page.getByLabel('Event PIN')).toHaveValue(/\d{4}/)

  await page.getByLabel('Event name').fill(EVENT_NAME)
  await page.getByLabel('Event PIN').fill('4242')
  await page.getByRole('button', { name: 'Save and show the QR' }).click()

  // Straight to the QR page — the next thing an admin does is show it to crew.
  await expect(page).toHaveURL(/\/connect$/)
  await expect(page.getByRole('heading', { name: EVENT_NAME })).toBeVisible()
  await expect(page.getByText('4242')).toBeVisible()

  // The name reaches the app itself, not just the server-rendered pages.
  const crew = await newDevice(browser, 'Setup Admin')
  await expect(crew.locator('.sidebar-brand h1')).toHaveText(EVENT_NAME)
  await expect(crew).toHaveTitle(new RegExp(EVENT_NAME))

  // And the door shuts: someone joined, so the unauthenticated form is gone.
  await page.goto('/setup')
  await expect(page).toHaveURL(/\/connect$/)

  await crew.context().close()
})

/**
 * The lockout this whole design replaces.
 *
 * Admin used to belong to whoever joined first. On a real box that admin
 * deleted their own account, and the panel became unreachable — no cog, no
 * route, nothing short of editing SQLite. So the two things worth proving
 * from a browser are that the cog is there for an ordinary crew member, and
 * that the password is what decides whether it opens.
 */
test('the admin panel is behind a password, and everyone can reach the door', async ({
  browser,
}) => {
  const crew = await newDevice(browser, 'Ordinary Crew')

  // Visible to a plain member — hiding it is how a box loses its admin.
  const cog = crew.getByRole('button', { name: 'Admin panel' })
  await expect(cog).toBeVisible()
  await cog.click()

  const password = crew.getByLabel('Admin password')
  await expect(password).toBeVisible()

  // The event PIN is on the poster, so it is the first thing anyone tries.
  await password.fill('4242')
  await crew.getByRole('button', { name: 'Unlock' }).click()
  await expect(crew.getByRole('alert')).toContainText(/not the admin password/i)

  await password.fill('e2e-admin-password')
  await crew.getByRole('button', { name: 'Unlock' }).click()
  await expect(crew.getByRole('heading', { name: 'Crew' })).toBeVisible()

  // Lock puts it back, so handing the phone over doesn't hand over the box.
  await crew.getByRole('button', { name: 'Lock' }).click()
  await cog.click()
  await expect(crew.getByLabel('Admin password')).toBeVisible()

  await crew.context().close()
})

/**
 * The lighting fields an env-configured box used to hide.
 *
 * The panel edits saved settings; the box runs on the environment where one
 * is set. This box is started with CREWBOX_DMX=sacn and nothing saved — the
 * arrangement every deploy script produces — so the saved mode is empty, and
 * a form reading that concluded lighting was off and hid the adapter and
 * universes fields entirely. Those two are not pinned by the environment, so
 * on such a box they were the only two an operator could set and the only
 * two that disappeared.
 */
test('an env-configured box still shows the lighting fields it lets you change', async ({
  browser,
}) => {
  const admin = await newDevice(browser, 'Networks Admin')
  await admin.getByRole('button', { name: 'Admin panel' }).click()
  await admin.getByLabel('Admin password').fill('e2e-admin-password')
  await admin.getByRole('button', { name: 'Unlock' }).click()
  await expect(admin.getByRole('heading', { name: 'Crew' })).toBeVisible()

  // The mode itself is pinned, and the note now names what it is pinned to.
  await expect(admin.getByText(/Set by CREWBOX_DMX in the environment to sacn/)).toBeVisible()

  // And the sub-section exists at all, which is the thing that vanished:
  // both rows are inside it, and neither was on the page before.
  await expect(admin.getByText('Lighting network adapter')).toBeVisible()
  await expect(admin.getByText('Set by CREWBOX_DMX_IFACE in the environment.')).toBeVisible()
  await expect(admin.getByText('sACN universes')).toBeVisible()
  await expect(admin.getByText('Set by CREWBOX_DMX_UNIVERSES in the environment.')).toBeVisible()

  await admin.context().close()
})
