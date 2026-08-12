import { expect, test, type Page } from '@playwright/test'
import { newDevice } from './helpers'

/**
 * The LED pane, through a real box.
 *
 * The unit tests cover the protocol and the gate. What only this layer can
 * show is the shape of the promise from a crew member's side: that reading is
 * everyone's, that changing what the box contacts is not, and that the second
 * confirmation is a real screen with the real traffic written on it rather
 * than a "are you sure?".
 */

const openVideo = async (page: Page) => {
  await page
    .getByRole('button', { name: /LED walls/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'LED walls' })).toBeVisible()
}

const unlockAdmin = async (page: Page) => {
  await page.getByRole('button', { name: 'Admin panel' }).click()
  await page.getByLabel('Admin password').fill('e2e-admin-password')
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByRole('heading', { name: 'Crew' })).toBeVisible()
  // Close the panel — the unlock survives it, and the video pane is where
  // the buttons actually are.
  await page.getByRole('button', { name: 'Close admin panel' }).click()
  await expect(page.getByRole('dialog', { name: 'Admin panel' })).toBeHidden()
}

test('the pane is readable by anyone and editable by nobody without the password', async ({
  browser,
}) => {
  const crew = await newDevice(browser, 'Screens Tech')
  await openVideo(crew)

  // A screens tech should not need an admin unlock to look at the wall.
  await expect(crew.getByText('crewbox reads LED processors and cannot control them')).toBeVisible()
  await expect(crew.getByText('An admin can add processors')).toBeVisible()
  await expect(crew.getByRole('button', { name: 'Add' })).toHaveCount(0)
  await expect(crew.getByRole('button', { name: /Sweep for processors/ })).toHaveCount(0)

  await crew.context().close()
})

test('adding a processor contacts nothing until somebody says so', async ({ browser }) => {
  const page = await newDevice(browser, 'Video Admin')
  await unlockAdmin(page)
  await openVideo(page)

  await page.getByLabel('Address').fill('10.99.99.11')
  await page.getByLabel('Name').fill('Upstage left')
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  await expect(page.getByText('Upstage left')).toBeVisible()
  await expect(page.getByText('Not watched')).toBeVisible()
  // The resting state, said out loud: the address is a note about the world,
  // not permission to talk to it.
  await expect(
    page.getByText(
      'The box has never contacted this address and will not until someone turns it on'
    )
  ).toBeVisible()

  await page.context().close()
})

test('starting to watch shows the exact traffic first, and can be backed out of', async ({
  browser,
}) => {
  const page = await newDevice(browser, 'Video Careful')
  await unlockAdmin(page)
  await openVideo(page)

  await page.getByLabel('Address').fill('10.99.99.12')
  await page.getByLabel('Name').fill('Downstage right')
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  // Scoped to this processor's row: the suite shares one box, so whatever an
  // earlier test added is still listed beside it.
  const row = page.getByRole('listitem').filter({ hasText: 'Downstage right' })
  await expect(row).toBeVisible()

  await row.getByRole('button', { name: 'Watch this…' }).click()

  // Not "are you sure?" — the addresses and ports, in words that can be
  // checked against a packet capture.
  const dialog = page.getByRole('dialog', { name: /Start watching/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('10.99.99.12:161')).toBeVisible()
  await expect(dialog.getByText('10.99.99.12:8001')).toBeVisible()
  await expect(
    dialog.getByText('There is no way for crewbox to change what is on the wall')
  ).toBeVisible()

  // Backing out leaves it exactly as it was.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(row.getByText('Not watched')).toBeVisible()

  // Confirming starts it. Nothing is at that address, so what follows is the
  // box discovering that — not a fake healthy row.
  await row.getByRole('button', { name: 'Watch this…' }).click()
  await page.getByRole('button', { name: 'Yes, send it' }).click()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 })
  await expect(row.getByRole('button', { name: 'Stop watching' })).toBeVisible()

  await page.context().close()
})

test('a sweep names every packet before it sends one', async ({ browser }) => {
  const page = await newDevice(browser, 'Video Sweeper')
  await unlockAdmin(page)
  await openVideo(page)

  await page.getByRole('button', { name: /Sweep for processors/ }).click()

  const dialog = page.getByRole('dialog', { name: /Sweep for LED processors/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/rqProMI:/)).toBeVisible()
  await expect(dialog.getByText(/224\.224\.125\.119/)).toBeVisible()
  await expect(
    dialog.getByText('It cannot change what is on a wall', { exact: false })
  ).toBeVisible()

  await dialog.getByRole('button', { name: 'Yes, send it' }).click()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 })

  // The sweep log prints what went on the wire, verbatim, for a venue that
  // wants to check it.
  await expect(page.getByText(/sent: 8 bytes "rqProMI:"/).first()).toBeVisible({ timeout: 15_000 })

  await page.context().close()
})

test('a phone can get into and back out of the LED pane', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(`Video Phone ${Date.now().toString(36)}`)
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  await page.getByRole('button', { name: 'Open channels' }).first().click()
  await page.getByRole('button', { name: 'Open LED walls' }).click()
  await expect(page.getByRole('heading', { name: 'LED walls' })).toBeVisible()

  // Navigating to a module closes the drawer, so a pane without the shell's
  // DrawerButton strands a phone user inside it with no way back.
  await page.getByRole('button', { name: 'Open channels' }).click()
  await page.getByRole('button', { name: '#general' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  await context.close()
})
