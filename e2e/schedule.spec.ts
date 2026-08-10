import { expect, test } from '@playwright/test'
import {
  commitCell,
  createSheet,
  newDevice,
  openPatch,
  openSheetByName,
  uniqueName,
} from './helpers'

/**
 * The running order module.
 *
 * Scope note: the time arithmetic — midnight rollover, sets that cross it,
 * implied end times, stage ordering — is covered by web/test/agenda.test.ts,
 * where it can be driven at any hour of any day. That is where the risk in
 * the model lives, and a browser test could only ever run at the time it
 * happens to run at.
 *
 * What is worth checking in a real browser is the wiring, and one thing that
 * is not obvious at all: reading somebody else's documents must not make you
 * look like a person in them.
 */
test('the running order is reachable and carries the shell drawer', async ({ browser }) => {
  const page = await newDevice(browser)

  await page
    .getByRole('button', { name: /Now & Next|off in|in \d/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'Running order' })).toBeVisible()
  await expect(page.getByText(/from the patch sheets/)).toBeVisible()

  // Deliberately not asserting the empty state here. The suite shares one
  // box, so by the time this runs other specs may have made patch sheets —
  // an "it says there are no sheets" assertion would pass or fail on test
  // order rather than on behaviour. What is order-independent is that the
  // module renders and is escapable.
  //
  // The drawer button is located by class, not by role: above 900px it is
  // display:none, which takes it out of the accessibility tree altogether,
  // so no role query can see it even with toBeAttached. Without it a phone
  // user who navigates here is stranded with a closed sidebar.
  await expect(page.locator('main .hamburger')).toBeAttached()
})

/**
 * The regression this module caused once and must not cause again.
 *
 * The running order reads every patch sheet on the box to work out what is
 * on. Opening a shared document used to announce this device in it, so every
 * phone running the running order appeared in every sheet's presence — a
 * patch operator saw company in a sheet nobody else had open, and the peer
 * count was wrong for everyone.
 *
 * Syncing a document and being a person in it are different things. This is
 * the test that says so.
 */
test('reading every sheet for the running order adds nobody to a sheet', async ({ browser }) => {
  const deviceA = await newDevice(browser)
  await openPatch(deviceA)
  const sheet = uniqueName('Presence Stage')
  await createSheet(deviceA, sheet)
  await commitCell(deviceA, 'Artist 1', '1', 'Input', 'Kick in')

  // Device B never opens the sheet — but its running order reads it, which
  // is exactly the situation that used to inflate the count.
  const deviceB = await newDevice(browser)
  await deviceB
    .getByRole('button', { name: /Now & Next|Presence Stage/ })
    .first()
    .click()
  await expect(deviceB.getByRole('heading', { name: 'Running order' })).toBeVisible()

  // One person is in this sheet, so the chip must not claim otherwise: it
  // says "Synced" alone for a single device.
  //
  // Scoped to main, and anchored. The suite shares a box, and an unanchored
  // /Synced/ matched a lighting plot another spec had named "Synced Rig" —
  // the same strict-mode trap this module's act names sprang on patch.spec.
  const chip = deviceA.locator('main').getByText(/^Synced/)
  await expect(chip).toBeVisible()
  await expect(chip).toHaveText('Synced')

  // And once B genuinely opens it, presence works as it always did — the
  // quiet reader is promoted to a person rather than staying invisible.
  await openPatch(deviceB)
  await openSheetByName(deviceB, sheet)
  await expect(chip).toHaveText('Synced · 2 devices')
})
