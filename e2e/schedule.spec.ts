import { expect, type Page } from '@playwright/test'
import { newDevice, test, uniqueName } from './helpers'

/**
 * The running order, now that the shell owns it.
 *
 * Scope note: the time arithmetic — midnight rollover, sets that cross it,
 * implied end times, stage ordering — is covered by web/test/agenda.test.ts,
 * and the document itself by web/test/timetable.test.ts, both of which can
 * be driven at any hour of any day. A browser test can only ever run at the
 * hour it happens to run at, so what is worth checking here is different:
 * that an act typed on one device is the running order on another, which is
 * the whole claim of moving this out of the patch sheets.
 */

/**
 * By route, not through the sidebar. The sidebar row's label is a live
 * countdown — "off in 20", "in 2h", "done" — so any locator for it passes or
 * fails on whatever time the suite happens to run at.
 */
const openRunningOrder = async (page: Page) => {
  await page.goto('/m/schedule')
  await expect(page.getByRole('heading', { name: 'Running order' })).toBeVisible()
}

test('an act added on one device is the running order on another', async ({ browser }) => {
  const deviceA = await newDevice(browser)
  await openRunningOrder(deviceA)

  await deviceA.getByRole('button', { name: 'Edit' }).click()
  await deviceA.getByRole('button', { name: '+ Add act' }).click()

  // Upper case in the fixture because the board renders stage names through
  // text-transform, and Playwright matches text as rendered rather than as
  // written — a lower-case fixture never matches.
  const act = uniqueName('HEADLINER')
  const stage = uniqueName('STAGE')

  // exact, and scoped to main: getByLabel matches substrings, so a bare
  // 'Act' also catches the row's "Remove this act" button, and a bare
  // 'Stage' catches the sidebar's own stage row.
  //
  // `.last()` is the row just added, deterministically: the editor sorts by
  // the same running order the sheets use, which puts an act with no date
  // and no time yet at the bottom — and a just-added one is the last of
  // those. The rest of the suite leaves acts on this box (a patch sheet
  // makes one), so "the only row" was never a safe assumption.
  const editor = deviceA.locator('main')
  await editor.getByLabel('Act', { exact: true }).last().fill(act)
  await editor.getByLabel('Stage', { exact: true }).last().fill(stage)
  await editor.getByLabel('On', { exact: true }).last().fill('21:00')
  await editor.getByLabel('Off', { exact: true }).last().fill('22:00')

  // The claim: no save button, no export, no second copy — device B is
  // simply looking at the same document.
  const deviceB = await newDevice(browser)
  await openRunningOrder(deviceB)

  // Scoped to this stage's own card, not to the board: other specs leave
  // their own stages on the running order, so "On now" appears several
  // times and an unscoped match trips strict mode. The stage name is unique
  // per run, which makes the card findable.
  //
  // The stage heading is asserted rather than the act name, because whether
  // an act is drawn on the card depends on whether it is on now or next —
  // a 21:00 slot is neither at half past midnight, and the suite runs at
  // whatever hour it runs at. The stage appears either way.
  const card = deviceB.locator('main li').filter({ hasText: stage })
  await expect(card.getByRole('heading', { name: stage })).toBeVisible()
  await expect(card.getByText('On now')).toBeVisible()

  // That the act itself crossed: B opens the same editor and finds it, with
  // no import, no export and no second copy. Located by the row's remove
  // button, whose label carries the act's name — an <input>'s value isn't
  // in the DOM, so there is nothing else on the row to match it by.
  await deviceB.getByRole('button', { name: 'Edit' }).click()
  await expect(deviceB.locator('main').getByRole('button', { name: `Remove ${act}` })).toBeVisible()
})

test('the running order is reachable and carries the shell drawer', async ({ browser }) => {
  const page = await newDevice(browser)
  await openRunningOrder(page)

  // Every module view needs the shell's drawer button, or a phone user who
  // navigates here is stranded with a closed sidebar.
  //
  // Located by class, not by role: above 900px it is display:none, which
  // takes it out of the accessibility tree altogether, so no role query can
  // see it even with toBeAttached.
  await expect(page.locator('main .hamburger')).toBeAttached()
})
