import { expect, test, type Page } from '@playwright/test'
import { FakeConsole } from '../dmxSender'
import { CREW, fixedDevice, phoneDevice, shoot } from './helpers'

/**
 * The docs screenshot run: one seeded event, photographed area by area into
 * site/docs/img/. Serial — the seed test builds the world, later tests
 * capture it. A failure skips the rest; fix and rerun `npm run docs:shots`,
 * which is the model anyway (the whole set regenerates every run).
 *
 * ORDERING RULE: /setup exists only until the first person joins, so the
 * seed captures it before any fixedDevice() call. Don't reorder that.
 */

test.describe.configure({ mode: 'serial' })

const EVENT = 'Ashton Court 2026'

let maya: Page
let dev: Page
let lena: Page
const rig = new FakeConsole()

test.afterAll(() => {
  rig.stop()
})

test('seed: the event, the crew, the paperwork', async ({ page, browser }) => {
  // --- /setup, photographed before it closes forever -----------------------
  await page.goto('/setup')
  await expect(page.getByLabel('Event name')).toBeVisible()
  await page.getByLabel('Event name').fill(EVENT)
  await shoot(page, 'setup-page')
  await page.getByRole('button', { name: 'Save and show the QR' }).click()
  await expect(page).toHaveURL(/\/connect$/)
  await shoot(page, 'connect-page')

  // --- the crew ------------------------------------------------------------
  maya = await fixedDevice(browser, CREW.sm)
  dev = await fixedDevice(browser, CREW.mons)
  lena = await fixedDevice(browser, CREW.lx)

  // --- channels ------------------------------------------------------------
  for (const name of ['stage', 'lx', 'foh']) {
    await maya.getByRole('button', { name: 'New channel' }).click()
    await maya.getByPlaceholder('channel-name').fill(name)
    await maya.keyboard.press('Enter')
    await expect(maya.getByRole('button', { name: `#${name}` })).toBeVisible()
  }

  // --- a changeover conversation in #stage ---------------------------------
  const say = async (page: Page, channel: string, body: string) => {
    await page.getByRole('button', { name: channel }).click()
    await page.getByPlaceholder(/Message/).fill(body)
    await page.keyboard.press('Enter')
    await expect(page.getByText(body.replace(/^@\S+\s/, '')).last()).toBeVisible()
  }
  await say(maya, '#stage', 'Changeover in 20 — drum riser rolls off first, then the BSNAKE move')
  await say(dev, '#stage', 'Mons ready. Wedges 3+4 are re-patched for the next act')
  await say(maya, '#stage', 'Riser crew standing by at USR')
  await say(dev, '#stage', '@Maya Quinn (SM) two more minutes on the DI swap, tell the runner')
  await say(lena, '#stage', 'LX clear of the deck, you can roll')
  await say(maya, '#stage', 'Copy all. Doors stay shut until FOH confirms line check')
  await say(lena, '#lx', 'Focus notes from soundcheck are in the plot — U1 addresses unchanged')
  await say(maya, '#foh', 'Day sheet for tomorrow is loading into the patch module now')

  // --- patch: the festival master patch ------------------------------------
  await maya.getByRole('button', { name: 'All sheets…' }).click()
  await maya.getByLabel('Import CSV file').setInputFiles('e2e/fixtures/festival-master-patch.csv')
  await expect(maya.getByLabel('Sheet title')).toBeVisible()
  await maya.getByLabel('Sheet title').fill('Riverside Weekender — Master Patch')
  await maya.getByLabel('Sheet title').press('Enter')

  // --- lighting: the MVR rig, renamed, with a trim set ---------------------
  await lena.getByRole('button', { name: 'All plots…' }).click()
  await lena.getByLabel('Import CSV or MVR file').setInputFiles('e2e/fixtures/rig.mvr')
  await expect(lena.getByRole('tab', { name: 'Fixtures' })).toBeVisible()
  await lena.getByLabel('Plot title').fill('Main Stage')
  await lena.getByLabel('Plot title').press('Enter')
  await lena.getByRole('button', { name: 'Positions' }).click()
  await lena.getByLabel(/Trim/).first().fill('7.5')
  await lena.getByLabel(/Trim/).first().press('Enter')
  await lena.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

  // --- the desk: real sACN on universe 1, left running ---------------------
  // Channel numbers are 1-indexed (a plain object, NOT an array — index 0
  // would overwrite the packet's DMX start code and every frame would be
  // rightly rejected). Addresses match the MVR: 4 × 16ch from 1; the GDTF
  // profile puts dimmer on 1, pan on 3/4, tilt on 5/6, colour on 7.
  await rig.start(1, {
    1: 255, // unit 1 dimmer full
    17: 180, // unit 2 dimmer
    19: 96, // unit 2 pan
    21: 140, // unit 2 tilt
    23: 40, // unit 2 colour wheel
  })
  await expect(lena.getByText(/receiving/).first()).toBeVisible({ timeout: 15_000 })
})

test('shots: joining and the shell', async ({ browser }) => {
  const phone = await phoneDevice(browser, CREW.prod)
  // The logged-out join screen, phone-sized: sign out first.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const joinPage = await context.newPage()
  await joinPage.goto('/?pin=4242')
  await expect(joinPage.getByLabel('Your name')).toBeVisible()
  await joinPage.getByLabel('Your name').fill('Sam Reyes (Stage)')
  await shoot(joinPage, 'join-screen')
  await context.close()

  // A phone lands with the drawer closed — open it to reach a channel.
  await phone.getByRole('button', { name: 'Open channels' }).first().click()
  await shoot(phone, 'drawer')
  await phone.getByRole('button', { name: '#stage' }).click()
  await shoot(phone, 'chat-phone')
  await phone.context().close()
})

test('shots: chat', async () => {
  await maya.getByRole('button', { name: '#stage' }).click()
  // Let the seed's import toast finish — it photobombed this scene once.
  await expect(maya.getByText(/Imported —/)).toBeHidden({ timeout: 15_000 })
  await shoot(maya, 'chat-overview')

  // The composer's @-mention picker, open.
  await maya.getByPlaceholder(/Message/).fill('@')
  await expect(maya.getByText('Tab to complete')).toBeVisible()
  await shoot(maya, 'chat-mention')
  await maya.getByPlaceholder(/Message/).clear()

  // The filter bar, filtering to one person.
  await maya.getByRole('button', { name: 'Filter messages' }).click()
  await maya.getByLabel('Filter by person').selectOption({ label: CREW.lx })
  await shoot(maya, 'chat-filter-bar')
  await maya.getByRole('button', { name: 'Hide message filter' }).click()

  // Search with results.
  await maya.getByRole('button', { name: 'Search messages' }).click()
  await maya.getByPlaceholder(/Search/).fill('changeover')
  await expect(maya.getByText(/drum riser/).first()).toBeVisible()
  await shoot(maya, 'chat-search')
  await maya.keyboard.press('Escape')
})

test('shots: patch sheets', async () => {
  await maya.getByRole('button', { name: 'All sheets…' }).click()
  await shoot(maya, 'patch-sheets')

  await maya
    .locator('main')
    .getByRole('button', { name: /Riverside Weekender/ })
    .first()
    .click()
  await expect(maya.getByLabel('Sheet title')).toBeVisible()
  await shoot(maya, 'patch-grid')

  // Dialogs close via their own × — not every one binds Escape.
  const closeDialog = () => maya.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

  await maya.getByRole('button', { name: 'Boxes' }).click()
  await shoot(maya, 'patch-subbox')
  await closeDialog()

  await maya.getByRole('button', { name: 'Stage Patch' }).click()
  await shoot(maya, 'patch-stage')
  await closeDialog()

  await maya.getByRole('button', { name: 'Lineup' }).click()
  await shoot(maya, 'patch-lineup')
  await closeDialog()

  await maya.getByRole('button', { name: 'Versions' }).click()
  await maya.getByLabel('Version name').fill('After soundcheck')
  await maya.getByRole('button', { name: 'Save current version' }).click()
  await expect(maya.getByText(/channels · /).first()).toBeVisible()
  await shoot(maya, 'patch-versions')
  await closeDialog()
})

test('shots: lighting', async () => {
  await lena.getByRole('button', { name: 'All plots…' }).click()
  await shoot(lena, 'lighting-plots')

  await lena
    .locator('main')
    .getByRole('button', { name: /Main Stage/ })
    .first()
    .click()
  await expect(lena.getByRole('tab', { name: 'Fixtures' })).toBeVisible()
  await expect(lena.getByText(/receiving/).first()).toBeVisible()
  await shoot(lena, 'lighting-fixtures')

  await lena.getByRole('button', { name: 'Positions' }).click()
  await shoot(lena, 'lighting-positions')
  await lena.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

  await lena.getByRole('tab', { name: 'Plan' }).click()
  await shoot(lena, 'lighting-plan')
  await lena.getByRole('tab', { name: 'Front' }).click()
  await shoot(lena, 'lighting-front')
  await lena.getByRole('tab', { name: '3D' }).click()
  await shoot(lena, 'lighting-3d')

  // Levels on: the plan dims and colours by what the desk is sending, and a
  // profiled fixture selected shows the channel-by-channel readout.
  await lena.getByRole('button', { name: 'Levels' }).click()
  await lena.getByRole('tab', { name: 'Plan' }).click()
  await shoot(lena, 'lighting-livebar')

  await lena.getByRole('tab', { name: 'Fixtures' }).click()
  await lena.locator('tbody tr').first().click()
  await expect(lena.getByText(/Dimmer/).first()).toBeVisible()
  await shoot(lena, 'lighting-gdtf')
})

test('shots: network audit', async () => {
  await dev.getByRole('button', { name: 'Open network audit' }).click()
  await expect(dev.getByRole('region', { name: 'Lighting network' })).toBeVisible()
  await expect(
    dev
      .getByRole('region', { name: 'Lighting network' })
      .getByText(/Lighting data|frames/i)
      .first()
  ).toBeVisible({ timeout: 20_000 })
  await shoot(dev, 'network-cards')
})

test('shots: admin', async () => {
  await maya.getByRole('button', { name: 'Admin panel' }).click()
  await expect(maya.getByPlaceholder("the box's admin password")).toBeVisible()
  await shoot(maya, 'admin-unlock')

  await maya.getByPlaceholder("the box's admin password").fill('shots-admin-password')
  await maya.keyboard.press('Enter')
  await expect(maya.getByRole('heading', { name: 'Admin' })).toBeVisible()
  await shoot(maya, 'admin-crew')

  // One scrolling panel, not tabs: bring the box section into view.
  await maya.getByRole('heading', { name: 'This box' }).scrollIntoViewIfNeeded()
  await shoot(maya, 'admin-this-box')

  // Leave the page usable for the tests after this one. The unlock itself
  // survives in memory, which is what lets the extras test run the probe.
  await maya.getByRole('button', { name: 'Close admin panel' }).click()
})

test('shots: extras — file detail, share, probe, phone modules', async ({ browser }) => {
  test.setTimeout(150_000)

  // A shared file and its detail view.
  await maya.getByRole('button', { name: '#foh' }).click()
  await maya.locator('input[type=file]').setInputFiles('e2e/fixtures/festival-day-sheet.csv')
  const card = maya.getByRole('button', { name: /festival-day-sheet/ }).first()
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.click()
  await expect(maya.getByRole('button', { name: 'Close file details' })).toBeVisible()
  await shoot(maya, 'chat-file-detail')
  await maya.getByRole('button', { name: 'Close file details' }).click()

  // The share-to-channel picker on a sheet.
  await maya.getByRole('button', { name: /Open sheet Riverside Weekender/ }).click()
  await expect(maya.getByLabel('Sheet title')).toBeVisible()
  await maya.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(maya.getByText('Share to channel')).toBeVisible()
  await shoot(maya, 'patch-share')
  // This dialog closes by clicking its overlay, not Escape.
  await maya.mouse.click(20, 400)
  await expect(maya.getByText('Share to channel')).toBeHidden()

  // The deep probe, run and photographed with its verbatim send list. The
  // sandbox has no internet, so the uplink/DNS rows show their fail-soft
  // states — which is honest, and exactly what the docs say happens.
  await maya.getByRole('button', { name: 'Open network audit' }).click()
  await maya.getByRole('button', { name: 'Run deep probe' }).click()
  await expect(maya.getByText(/Last run/)).toBeVisible({ timeout: 90_000 })
  await expect(maya.getByText(/sent:/).first()).toBeVisible()
  // The verbatim send list is the point of this scene — bring it into frame.
  await maya.getByRole('heading', { name: 'Deep probe' }).scrollIntoViewIfNeeded()
  await shoot(maya, 'network-probe')

  // Phone-sized module views: the grid and the plan.
  const phone = await phoneDevice(browser, CREW.prod)
  await phone.getByRole('button', { name: 'Open channels' }).first().click()
  await phone.getByRole('button', { name: /Open sheet Riverside Weekender/ }).click()
  await expect(phone.getByLabel('Sheet title')).toBeVisible()
  await shoot(phone, 'patch-grid-phone')

  await phone.getByRole('button', { name: 'Open channels' }).first().click()
  await phone.getByRole('button', { name: /Open plot Main Stage/ }).click()
  await phone.getByRole('tab', { name: 'Plan' }).click()
  await shoot(phone, 'lighting-plan-phone')
  await phone.context().close()
})
