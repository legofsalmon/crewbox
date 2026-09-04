import { expect } from '@playwright/test'
import {
  cell,
  commitCell,
  createSheet,
  newDevice,
  openPatch,
  openSheetByName,
  test,
  uniqueName,
} from './helpers'

test('sheet edits persist across reload and the URL deep-links the sheet', async ({ browser }) => {
  const page = await newDevice(browser)
  await openPatch(page)
  const name = uniqueName('Persist Fest')
  await createSheet(page, name)

  await commitCell(page, 'Act 1', '1', 'Input', 'Kick')
  await commitCell(page, 'Act 1', '2', 'Description', 'Snare top')
  await expect(page).toHaveURL(/\/m\/patch\/sheet\//)

  await page.reload()
  // The route restores the same sheet without any navigation.
  await expect(page.locator('table')).toBeVisible()
  await expect(cell(page, 'Act 1', '1', 'Input')).toHaveValue('Kick')
  await expect(cell(page, 'Act 1', '2', 'Description')).toHaveValue('Snare top')
})

/**
 * A new sheet used to book a band.
 *
 * It seeded an "Act 1" onto the event's running order, which is not the
 * sheet's document — it is the whole festival's, read by the schedule
 * module, by the countdown in every crew member's sidebar and by the
 * production desk over the control API. So making a patch sheet put a band
 * nobody had booked on a stage nobody had booked, in front of everyone;
 * renaming the stage afterwards dragged the placeholder onto a real one; and
 * deleting the sheet left it there for good, because the act was never the
 * sheet's to remove.
 */
test('a new sheet books nothing on the running order', async ({ browser }) => {
  const page = await newDevice(browser)
  await openPatch(page)
  const name = uniqueName('Empty Fest')

  // Deliberately not the `createSheet` helper: that adds an act, which is
  // the thing under test.
  await page.getByRole('button', { name: '+ New Sheet' }).click()
  await page.locator('#new-sheet-name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('table')).toBeVisible()

  // The grid says so, and names both ways out.
  await expect(page.getByText(`Nothing is on ${name} yet`)).toBeVisible()

  // And the running order agrees, which is the half that used to be wrong.
  await page.getByRole('button', { name: 'Lineup', exact: true }).click()
  await expect(page.getByText(`Nothing on ${name}`)).toBeVisible()
  await expect(page.getByLabel('Act name')).toHaveCount(0)

  // Adding one is one click, and then the grid has its column.
  await page.getByRole('button', { name: '+ Add Act' }).click()
  const field = page.getByLabel('Act name')
  await field.fill('The Harbour Lights')
  await field.blur()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(cell(page, 'The Harbour Lights', '1', 'Input')).toBeVisible()

  await page.context().close()
})

test('two devices sync a sheet through the box, with crew identity presence', async ({
  browser,
}) => {
  const nameA = `Ava${Date.now().toString(36).slice(-4)}`
  const deviceA = await newDevice(browser, nameA)
  await openPatch(deviceA)
  const sheet = uniqueName('Main Stage')
  await createSheet(deviceA, sheet)
  await commitCell(deviceA, 'Act 1', '1', 'Input', 'Kick in')

  // Device B: a different crew member finds the sheet via the synced index.
  const deviceB = await newDevice(browser)
  await openPatch(deviceB)
  await openSheetByName(deviceB, sheet)
  await expect(cell(deviceB, 'Act 1', '1', 'Input')).toHaveValue('Kick in')

  // Edits flow the other way too.
  await commitCell(deviceB, 'Act 1', '3', 'Mic/DI', 'SM57')
  await expect(cell(deviceA, 'Act 1', '3', 'Mic/DI')).toHaveValue('SM57')

  // Presence carries the real crew name from the roster, not a self-typed one.
  await cell(deviceA, 'Act 1', '1', 'Input').click()
  await expect(deviceB.locator('main').locator(`[title="${nameA}"]`).first()).toBeVisible()

  // The status chip reflects the shared room.
  await expect(deviceA.getByText(/Synced · 2 devices/)).toBeVisible()
})

test('undo on one device never reverts the other device’s edit', async ({ browser }) => {
  const deviceA = await newDevice(browser)
  await openPatch(deviceA)
  const sheet = uniqueName('Undo Fest')
  await createSheet(deviceA, sheet)

  const deviceB = await newDevice(browser)
  await openPatch(deviceB)
  await openSheetByName(deviceB, sheet)

  await commitCell(deviceA, 'Act 1', '1', 'Input', 'A edit')
  await commitCell(deviceB, 'Act 1', '2', 'Input', 'B edit')
  await expect(cell(deviceA, 'Act 1', '2', 'Input')).toHaveValue('B edit')
  await expect(cell(deviceB, 'Act 1', '1', 'Input')).toHaveValue('A edit')

  // A's undo takes back only A's own edit — B's survives on both devices.
  await deviceA.keyboard.press('ControlOrMeta+z')
  await expect(cell(deviceA, 'Act 1', '1', 'Input')).toHaveValue('')
  await expect(cell(deviceA, 'Act 1', '2', 'Input')).toHaveValue('B edit')
  await expect(cell(deviceB, 'Act 1', '1', 'Input')).toHaveValue('')
})

test('pasting a Sheets-style block fills the grid and undoes as one step', async ({ browser }) => {
  const page = await newDevice(browser)
  await openPatch(page)
  await createSheet(page, uniqueName('Paste Fest'))

  await cell(page, 'Act 1', '1', 'Input').click()
  await page.evaluate(() => {
    const target = document.activeElement as HTMLInputElement
    const data = new DataTransfer()
    data.setData('text/plain', 'Kick\tBeta 91\nSnare\t57\nHat\tKM184')
    target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    )
  })
  await expect(cell(page, 'Act 1', '1', 'Input')).toHaveValue('Kick')
  await expect(cell(page, 'Act 1', '2', 'Input')).toHaveValue('Snare')
  await expect(cell(page, 'Act 1', '3', 'Input')).toHaveValue('Hat')
  await expect(cell(page, 'Act 1', '2', 'Description')).toHaveValue('57')

  await page.keyboard.press('ControlOrMeta+z')
  await expect(cell(page, 'Act 1', '1', 'Input')).toHaveValue('')
  await expect(cell(page, 'Act 1', '3', 'Input')).toHaveValue('')
})

test('sharing a sheet posts a chat link that opens the sheet on another device', async ({
  browser,
}) => {
  const deviceA = await newDevice(browser)
  await openPatch(deviceA)
  const sheet = uniqueName('Share Fest')
  await createSheet(deviceA, sheet)
  await commitCell(deviceA, 'Act 1', '1', 'Input', 'Kick')

  await deviceA.getByRole('button', { name: 'Share', exact: true }).click()
  await deviceA
    .getByLabel('Share sheet to a channel')
    .getByRole('button', { name: '#general' })
    .click()

  // Device B lands in #general by default, sees the share, and the chip
  // deep-links straight into the patch module.
  const deviceB = await newDevice(browser)
  const shareMsg = deviceB.locator('.msg', { hasText: sheet })
  await expect(shareMsg.first()).toBeVisible()
  await shareMsg.first().getByRole('button', { name: 'Open ↗' }).click()
  await expect(deviceB).toHaveURL(/\/m\/patch\/sheet\//)
  await expect(cell(deviceB, 'Act 1', '1', 'Input')).toHaveValue('Kick')
})

test('the sheet title shares the nav row rather than taking one of its own', async ({
  browser,
}) => {
  const page = await newDevice(browser)
  await openPatch(page)
  await createSheet(page, uniqueName('Header Fest'))

  // A patch sheet used to spend a whole row on its title, so a phone gave up
  // about 15% of the screen to chrome before any patch showed. The title now
  // sits inline beside the back button, the same shape a lighting plot uses.
  const header = page.locator('header').filter({ has: page.getByLabel('Sheet title') })
  const back = await header.getByRole('button', { name: 'All sheets' }).boundingBox()
  const title = await header.getByLabel('Sheet title').boundingBox()
  expect(back).not.toBeNull()
  expect(title).not.toBeNull()
  // Same row: their vertical centres line up to within a few pixels.
  const centre = (b: { y: number; height: number }) => b.y + b.height / 2
  expect(Math.abs(centre(back!) - centre(title!))).toBeLessThan(6)

  // And the whole of the chrome — nav row plus tool row — stays under the
  // height two stacked rows of inputs used to reach.
  const grid = await page.locator('table').boundingBox()
  expect(grid!.y).toBeLessThan(130)
})

/**
 * The sheet a festival actually keeps.
 *
 * Not a one-header-row CSV: a title, a colour legend for the sub-snakes, and
 * a two-tier header with act names spanning three columns each. The generic
 * importer read the title row as the header and produced one act and a
 * hundred empty channels; this is the shape that has to survive.
 */
test('a festival master patch imports with its acts, inputs and sub-snakes', async ({
  browser,
}) => {
  const page = await newDevice(browser, 'Festival Tech')

  await openPatch(page)
  await page.locator('input[type=file]').setInputFiles('e2e/fixtures/festival-master-patch.csv')
  await expect(page.locator('table')).toBeVisible()

  // Seven acts across the top, not one called "Act 1". Scoped to the main
  // pane for the reason openSheetByName already documents: the sidebar shows
  // the same names — the running order lists whoever is on each stage — and
  // two matches trip Playwright's strict mode.
  await expect(page.locator('main').getByText('THE HARBOUR LIGHTS')).toBeVisible()
  await expect(page.locator('main').getByText('MARGOT DUNN')).toBeVisible()

  // The house input list came down the left, once, rather than per act.
  await expect(page.getByLabel('Input on channel 1', { exact: true })).toHaveValue('KICK IN')
  await expect(page.getByLabel('Input on channel 2', { exact: true })).toHaveValue('SNARE TOP')

  // Each act keeps its own sub-box and mic against the same channel.
  await expect(page.getByLabel('THE HARBOUR LIGHTS, channel 1, Sub-box')).toHaveValue('BSNAKE 1')
  await expect(page.getByLabel('MARGOT DUNN, channel 1, Mic/DI')).toHaveValue('BEYER')

  // And the colour legend became real sub-boxes, not text in cells.
  await page.getByRole('button', { name: 'Boxes' }).click()
  const names = page.getByRole('dialog').getByLabel('Sub-box name')
  await expect(names).toHaveCount(5)
  await expect(names.first()).toHaveValue('PINK')
  await expect(names.last()).toHaveValue('YELLOW')
})

/**
 * The table that used to be filled in by hand: five boxes × twelve tails ×
 * seven acts is 420 cells, kept in parallel with the grid and wrong the
 * moment either changes. Every cell already knows its box and its tail.
 */
test('the stage patch is derived from the grid, not typed again', async ({ browser }) => {
  const page = await newDevice(browser, 'Stage Tech')

  await openPatch(page)
  await page.locator('input[type=file]').setInputFiles('e2e/fixtures/festival-master-patch.csv')
  await expect(page.locator('table')).toBeVisible()

  await page.getByRole('button', { name: 'Stage Patch' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Stage patch for').selectOption({ label: 'MARGOT DUNN' })

  // "BSNAKE 1" in a cell means tail 1 of BSNAKE, carrying channel 1's input.
  const bsnake = dialog.locator('section').filter({ hasText: 'BSNAKE' }).first()
  const first = bsnake.locator('tbody tr').first()
  await expect(first).toContainText('BSNAKE 1')
  await expect(first).toContainText('KICK IN')
  await expect(first).toContainText('BEYER')

  // Declared-but-unused boxes fold away rather than burying the answer.
  await expect(dialog.getByRole('button', { name: /Show 5 unused boxes/ })).toBeVisible()
  await dialog.getByRole('button', { name: /Show 5 unused boxes/ }).click()
  await expect(dialog.getByText('USC')).toBeVisible()

  // Editing the grid moves the stage patch, because it is the same data.
  await dialog.getByRole('button', { name: 'Close' }).click()
  const cell = page.getByLabel('MARGOT DUNN, channel 1, Sub-box')
  await cell.fill('BSNAKE 4')
  await cell.press('Enter')

  await page.getByRole('button', { name: 'Stage Patch' }).click()
  await page
    .getByRole('dialog')
    .getByLabel('Stage patch for')
    .selectOption({ label: 'MARGOT DUNN' })
  const moved = page.getByRole('dialog').locator('section').filter({ hasText: 'BSNAKE' }).first()
  // BSNAKE is only named in cells, so nothing says how wide it is and an
  // unused tail simply isn't listed — tail 1 is gone rather than blank.
  await expect(moved.locator('tbody tr').first()).toContainText('BSNAKE 2')
  // Tail 4 now has two channels on it, which the paper version cannot show
  // at all: there is one box to write a channel number in.
  await expect(page.getByRole('dialog').getByText(/Two channels on one tail/)).toBeVisible()
  await expect(page.getByRole('dialog').getByText('BSNAKE 4', { exact: true })).toBeVisible()
})

/**
 * The changeover: how long there is between one act coming down and the next
 * going on. On a festival stage it is the number the day is planned around,
 * and the sheet keeps it as free text ("45", "HR") in the narrow column
 * beside each act name.
 */
test('the changeover between two acts comes across, and is checked', async ({ browser }) => {
  const page = await newDevice(browser, 'Changeover Tech')

  await openPatch(page)
  await page.locator('input[type=file]').setInputFiles('e2e/fixtures/festival-day-sheet.csv')
  // Longer than the 5 s default, and only here. This import is the heaviest
  // thing in the suite — 56 channels × 16 acts parsed, a document created,
  // IndexedDB written and the running order synced — on a fresh device
  // against a box that by this point in the run holds a whole day of
  // sheets, plots and log entries. It sat on the default timeout and fell
  // off it three times across two branches; the app is doing real work, so
  // the test gets the room rather than the app losing the feature.
  //
  // Half of that was not the app: every spec before this one left its
  // browser contexts open, so by here Chromium was running thirty idle
  // pages with live sockets. That is fixed (see `newDevice`), and this spec
  // now takes about five seconds on its own. The margin stays until
  // somebody has watched a few full runs — a timeout tightened on one
  // measurement is how it came to be raised in the first place.
  await expect(page.locator('table')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Lineup' }).click()

  // "45" on the second act and "HR" on the next two — an hour, written the
  // way a crew writes it. The first act has none: nothing to change over
  // from.
  const changeovers = page.locator('input[type=number]')
  await expect(changeovers.nth(0)).toHaveValue('45')
  await expect(changeovers.nth(1)).toHaveValue('60')
  await expect(changeovers.nth(2)).toHaveValue('60')

  // Move one so it disagrees with the running order, and it says so rather
  // than quietly holding two different answers.
  await changeovers.nth(1).fill('30')
  await changeovers.nth(1).blur()
  await expect(page.getByText('the set times leave 1 hr')).toBeVisible()
})

/**
 * Two things the sheet's own chrome got wrong.
 *
 * Find never searched the house input column — the sheet's spine, what is on
 * channel 12 all day whoever is playing. It is the only column with the same
 * value for every act, so the miss was the least visible and the most
 * annoying: the search looked like it worked.
 *
 * And Ctrl+Z in a dialog reverted the sheet behind the modal. The shortcut
 * claimed every key press except a half-typed grid cell and the find box, so
 * taking back a word in an act's name in the Lineup undid the last committed
 * edit to the grid instead — silently, because the modal covers it.
 */
test('find searches the input column, and Ctrl+Z in a dialog stays in the dialog', async ({
  browser,
}) => {
  const page = await newDevice(browser)
  await openPatch(page)
  await createSheet(page, uniqueName('Find Fest'))

  // The house input on channel 1, and a patch cell that does not match it.
  const houseInput = page.getByLabel('Input on channel 1', { exact: true })
  await houseInput.fill('KICK IN')
  await houseInput.blur()
  await commitCell(page, 'Act 1', '2', 'Mic/DI', 'SM57')

  const find = page.getByLabel('Find in sheet')
  await find.fill('KICK IN')
  // One match, and it is the spine — not a patch cell.
  await expect(page.getByText('1 match', { exact: true })).toBeVisible()
  await expect(houseInput).toHaveClass(/matchCell/)
  await find.fill('')

  // Now the undo guard. Commit something to the grid to have an undo target.
  await commitCell(page, 'Act 1', '1', 'Description', 'Kick drum')
  await expect(cell(page, 'Act 1', '1', 'Description')).toHaveValue('Kick drum')

  await page.getByRole('button', { name: 'Lineup', exact: true }).click()
  const name = page.getByLabel('Act name')
  await name.click()
  await name.type(' and Friends')
  await page.keyboard.press('ControlOrMeta+z')
  await page.getByRole('button', { name: 'Close' }).click()

  // The grid is exactly as it was: the undo went to the text, not the sheet.
  await expect(cell(page, 'Act 1', '1', 'Description')).toHaveValue('Kick drum')

  await page.context().close()
})
