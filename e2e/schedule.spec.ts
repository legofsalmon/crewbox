import { expect, test, type Page } from '@playwright/test'
import { newDevice, uniqueName } from './helpers'

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
  const editor = deviceA.locator('main')
  await editor.getByLabel('Act', { exact: true }).last().fill(act)
  await editor.getByLabel('Stage', { exact: true }).last().fill(stage)
  await editor.getByLabel('On', { exact: true }).last().fill('21:00')
  await editor.getByLabel('Off', { exact: true }).last().fill('22:00')

  // The claim: no save button, no export, no second copy — device B is
  // simply looking at the same document.
  const deviceB = await newDevice(browser)
  await openRunningOrder(deviceB)

  // Scoped to main: the sidebar carries the same stage, which is the point
  // of it, and two matches trip strict mode.
  //
  // The stage heading is asserted rather than the act name, because whether
  // an act is drawn on the board depends on whether it is on now or next —
  // a 21:00 slot is neither at half past midnight, and the suite runs at
  // whatever hour it runs at. The stage appears either way.
  const board = deviceB.locator('main')
  await expect(board.getByRole('heading', { name: stage })).toBeVisible()
  await expect(board.getByText('On now')).toBeVisible()

  // That the act itself crossed: B opens the same editor and finds it, with
  // no import, no export and no second copy.
  await deviceB.getByRole('button', { name: 'Edit' }).click()
  await expect(deviceB.locator('main').getByLabel('Act', { exact: true })).toHaveValue(act)
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
