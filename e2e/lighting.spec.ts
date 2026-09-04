import { expect, type Page } from '@playwright/test'
import { newDevice, test, uniqueName } from './helpers'
import { FakeConsole } from './dmxSender'

/**
 * The lighting module through a real box: a plot syncing between two
 * devices, and the DMX collision detection that is the reason the module
 * exists.
 */

const openLighting = async (page: Page) => {
  await page.getByRole('button', { name: 'All plots…' }).click()
  await expect(page.getByRole('heading', { name: 'Lighting Plots' })).toBeVisible()
}

const createPlot = async (page: Page, name: string) => {
  await page.getByRole('button', { name: '+ New Plot' }).click()
  await page.locator('#new-plot-name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Fixtures' })).toBeVisible()
}

/** Add a fixture to the first position group and address it. */
const addFixture = async (
  page: Page,
  { purpose, address, footprint }: { purpose: string; address: number; footprint: number }
) => {
  await page.locator('main').getByRole('button', { name: '+ Fixture' }).first().click()
  const row = page.locator('tbody tr').last()
  await row.getByLabel(/^Purpose/).fill(purpose)
  await row.getByLabel(/^Purpose/).press('Enter')
  await row.getByLabel(/^Footprint/).fill(String(footprint))
  await row.getByLabel(/^Footprint/).press('Enter')
  await row.getByLabel(/^Address/).fill(String(address))
  await row.getByLabel(/^Address/).press('Enter')
}

test('a plot syncs between two devices with crew identity presence', async ({ browser }) => {
  const alice = await newDevice(browser, 'Alice Lighting')
  const bob = await newDevice(browser, 'Bob Lighting')
  const plotName = uniqueName('Main Stage Rig')

  await openLighting(alice)
  await createPlot(alice, plotName)
  await addFixture(alice, { purpose: 'DS Wash SL', address: 1, footprint: 16 })

  // Bob opens the same plot from the synced index, not from a link.
  await openLighting(bob)
  await bob.locator('main').getByText(plotName).first().click()
  await expect(bob.getByRole('tab', { name: 'Fixtures' })).toBeVisible()

  await expect(bob.getByLabel(/^Purpose/).first()).toHaveValue('DS Wash SL')

  // Presence carries the roster name, not a self-assigned one.
  await expect(alice.getByLabel(/Also here: .*Bob Lighting/)).toBeVisible({ timeout: 10_000 })

  // An edit on Bob's device lands on Alice's.
  await bob
    .getByLabel(/^Circuit/)
    .first()
    .fill('A12')
  await bob
    .getByLabel(/^Circuit/)
    .first()
    .press('Enter')
  await expect(alice.getByLabel(/^Circuit/).first()).toHaveValue('A12', { timeout: 10_000 })
})

test('overlapping DMX addresses are flagged on both fixtures', async ({ browser }) => {
  const page = await newDevice(browser, 'Patch Tech')

  await openLighting(page)
  await createPlot(page, uniqueName('Clash Test'))

  // 16 channels from 1 occupies 1–16; 16 channels from 10 occupies 10–25.
  await addFixture(page, { purpose: 'Head 1', address: 1, footprint: 16 })
  await addFixture(page, { purpose: 'Head 2', address: 10, footprint: 16 })

  await expect(page.getByText('2 addressing problems')).toBeVisible()
  await expect(page.getByTestId('fixture-warning')).toHaveCount(2)

  // Moving the second clear of the first resolves both warnings.
  const second = page.locator('tbody tr').last()
  await second.getByLabel(/^Address/).fill('17')
  await second.getByLabel(/^Address/).press('Enter')

  await expect(page.getByTestId('fixture-warning')).toHaveCount(0)
  await expect(page.getByText(/addressing problem/)).toHaveCount(0)
})

test('a phone can always get back to the sidebar from inside a module', async ({ browser }) => {
  // Navigating to a module closes the drawer, and module panes used to have
  // no hamburger — so opening one on a phone stranded you there with no way
  // back to chat or to any other module.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill('Phone Tech')
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  for (const [open, target] of [
    ['All plots…', 'Lighting Plots'],
    ['All sheets…', 'Patch Sheets'],
  ] as const) {
    await page.getByRole('button', { name: 'Open channels' }).first().click()
    await page.getByRole('button', { name: open }).click()
    await expect(page.getByRole('heading', { name: target })).toBeVisible()
    // The selector itself must offer a way back out.
    await expect(page.getByRole('button', { name: 'Open channels' })).toBeVisible()
  }

  // ...and so must a module's inner view. (The loop above finished on the
  // patch selector, so come back to lighting through the drawer.)
  await page.getByRole('button', { name: 'Open channels' }).first().click()
  await page.getByRole('button', { name: 'All plots…' }).click()
  await createPlot(page, uniqueName('Phone Rig'))
  await expect(page.getByRole('button', { name: 'Open channels' })).toBeVisible()
  await page.getByRole('button', { name: 'Open channels' }).click()
  await page.getByRole('button', { name: '#general' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  // And the one pane that is not a module's own view: a deep link to
  // something this box has switched off, or a build that never had it. It
  // had no header at all, so a phone landed in a dead end and had to be
  // reloaded out of.
  await page.goto('/m/no-such-module')
  await expect(page.getByText(/isn.t available on this server/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open channels' })).toBeVisible()
  await page.getByRole('button', { name: 'Open channels' }).click()
  await page.getByRole('button', { name: '#general' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  await context.close()
})

test('importing an MVR populates fixtures, footprints and a placed position', async ({
  browser,
}) => {
  const page = await newDevice(browser, 'MVR Tech')

  await openLighting(page)
  await createPlot(page, uniqueName('MVR Rig'))

  await page.locator('input[type=file]').setInputFiles('e2e/fixtures/rig.mvr')

  await expect(page.getByText(/Imported 4 fixtures across 1 position/)).toBeVisible()

  // The MVR's own layer became the position, not the default truss.
  await expect(page.getByRole('heading', { name: 'Upstage Truss' })).toBeVisible()

  const rows = page.locator('tbody tr')
  await expect(rows).toHaveCount(4)

  // Footprints come from the embedded GDTF profile (Sharpy = 16ch), which is
  // the whole reason MVR beats a CSV.
  for (let i = 0; i < 4; i++) {
    await expect(rows.nth(i).getByLabel(/^Footprint/)).toHaveValue('16')
  }

  // Fixtures are ordered along the bar, not in the order the file listed
  // them — the file has Sharpy 3 first and Sharpy 1 second.
  await expect(rows.first().getByLabel(/^Purpose/)).toHaveValue('Sharpy 1')
  await expect(rows.last().getByLabel(/^Purpose/)).toHaveValue('Sharpy 4')

  // Addressed 1/17/33/49 at 16ch each — nose to tail, so nothing clashes.
  await expect(page.getByTestId('fixture-warning')).toHaveCount(0)
  await expect(page.getByText('U1: 64/512')).toBeVisible()
})

test('a plot survives reload and deep-links back to itself', async ({ browser }) => {
  const page = await newDevice(browser, 'Reload Tech')
  const plotName = uniqueName('Reload Rig')

  await openLighting(page)
  await createPlot(page, plotName)
  await addFixture(page, { purpose: 'Key light', address: 100, footprint: 8 })

  const url = page.url()
  expect(url).toContain('/m/lighting/plot/')

  await page.reload()
  await expect(page.getByLabel(/^Purpose/).first()).toHaveValue('Key light')
})

/**
 * The two new drawings, and the height that makes them mean anything.
 *
 * The plan can't answer "how high is it", which is the question that decides
 * whether a truss clears the video wall. Both views read the same trim off
 * the position, so this sets one and checks it reaches both.
 */
test('the front elevation and 3D view draw the rig at its trim heights', async ({ browser }) => {
  const page = await newDevice(browser, 'Elevation Tech')

  await openLighting(page)
  await createPlot(page, uniqueName('Trim Rig'))

  await page.getByRole('button', { name: 'Positions' }).click()
  const truss = page.locator('[role=dialog] li').first()
  await truss.getByLabel('Position name').fill('DS Truss')
  await truss.getByLabel('Position name').press('Enter')
  await truss.getByLabel(/Trim height/).fill('8.5')
  await truss.getByLabel(/Trim height/).press('Enter')

  // A boom stands up off the deck rather than flying, so its height field
  // is named for what it is.
  await page.locator('#new-position-name').fill('SL Boom')
  await page.getByRole('button', { name: 'Add position' }).click()
  const boom = page.locator('[role=dialog] li').last()
  await boom.getByLabel(/^Kind of/).selectOption({ label: 'Boom' })
  await expect(boom.getByText('Height m')).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()

  // Onto the truss, not the toolbar's unassigned "+ Fixture" — a fixture
  // with no position has nowhere to be drawn, in any of the three views.
  const group = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'DS Truss', exact: true }) })
  await group.getByRole('button', { name: '+ Fixture' }).click()
  const row = group.locator('tbody tr').last()
  await row.getByLabel(/^Purpose/).fill('Key light')
  await row.getByLabel(/^Purpose/).press('Enter')

  await page.getByRole('tab', { name: 'Front' }).click()
  // The trim is on the drawing, not just in the Positions dialog.
  await expect(page.getByText('DS Truss · 8.5 m')).toBeVisible()
  await expect(page.getByRole('img', { name: /Front elevation of/ })).toBeVisible()

  await page.getByRole('tab', { name: '3D' }).click()
  await expect(page.getByRole('img', { name: /3D view of/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset view' })).toBeVisible()

  // Picking a fixture in a drawing takes you to its row in the paperwork.
  await page
    .getByRole('button', { name: /Key light/ })
    .first()
    .click()
  await expect(page.getByLabel(/^Purpose/).first()).toHaveValue('Key light')
})

/** A plot written before trim heights existed still opens, and hangs. */
test('a truss with no stored trim height still draws above the deck', async ({ browser }) => {
  const page = await newDevice(browser, 'Legacy Tech')
  await openLighting(page)
  await createPlot(page, uniqueName('Legacy Rig'))

  await page.getByRole('button', { name: 'Positions' }).click()
  // A fresh truss gets the kind's default rather than sitting on the floor.
  await expect(
    page
      .locator('[role=dialog] li')
      .first()
      .getByLabel(/Trim height/)
  ).toHaveValue('6')
  await page.getByRole('button', { name: 'Close' }).click()
})

/**
 * How much truss to order.
 *
 * The plot knows the fixtures long before anyone knows the truss, so this
 * does the arithmetic a production call would otherwise do by hand: widths,
 * the gap between neighbours, and what stock lengths add up to it.
 */
test('a position works out the truss its fixtures need', async ({ browser }) => {
  const page = await newDevice(browser, 'Truss Tech')

  await openLighting(page)
  await createPlot(page, uniqueName('Order Rig'))

  // Six Sharpys: 6 × 360 mm of fixture, 5 × 250 mm of air between them.
  const group = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Upstage Truss', exact: true }) })
  for (let i = 1; i <= 6; i++) {
    await group.getByRole('button', { name: '+ Fixture' }).click()
    const row = group.locator('tbody tr').last()
    await row.getByLabel(/^Type/).selectOption({ label: 'Clay Paky Sharpy' })
  }

  await page.getByRole('button', { name: 'Positions' }).click()
  await expect(page.getByText('Needs 3.4 m · 1 × 3 m + 1 × 0.5 m')).toBeVisible()

  // It offers, it doesn't act: an estimate that quietly rewrote the drawing
  // would be worse than no estimate.
  const truss = page.locator('[role=dialog] li').first()
  await expect(truss.getByLabel(/Length of/)).toHaveValue('12')
  await page.getByRole('button', { name: 'Set to 3.5 m' }).click()
  await expect(truss.getByLabel(/Length of/)).toHaveValue('3.5')

  // Once the bar matches the estimate there is nothing left to offer.
  await expect(page.getByRole('button', { name: /^Set to/ })).toHaveCount(0)
})

/**
 * Watching a real lighting network.
 *
 * The box is started with CREWBOX_DMX=sacn on loopback (see
 * playwright.config.ts) and a synthetic console sends to it. Crewbox itself
 * never transmits — its sockets have `send` removed — so the sender lives in
 * the test.
 */
test('a plot says which fixtures the desk is actually sending to', async ({ browser }) => {
  const console_ = new FakeConsole()
  try {
    // Universe 1, channel 201 up. Nothing on 300.
    //
    // Deliberately clear of 1–64, which the profiled-rig test below patches
    // an imported MVR into: the box's `everLit` map is per universe and
    // never resets while it is listening, which is the right behaviour and
    // means two tests sharing a universe also share what has ever been lit.
    await console_.start(1, { 201: 255 })

    const page = await newDevice(browser, 'Live Tech')
    await openLighting(page)
    await createPlot(page, uniqueName('Live Rig'))

    const group = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Upstage Truss', exact: true }) })

    // One fixture on channel 1 — being sent to. One on 100 — not.
    for (const [purpose, address] of [
      ['Getting data', 201],
      ['Nothing sent', 300],
    ] as const) {
      await group.getByRole('button', { name: '+ Fixture' }).click()
      const row = group.locator('tbody tr').last()
      await row.getByLabel(/^Purpose/).fill(purpose)
      await row.getByLabel(/^Purpose/).press('Enter')
      await row.getByLabel(/^Address/).fill(String(address))
      await row.getByLabel(/^Address/).press('Enter')
    }

    // The bar reports the split, and says what window it can speak for.
    await expect(page.getByText(/1 receiving/)).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(/1 nothing sent/)).toBeVisible()
    await expect(page.getByText(/^since /)).toBeVisible()

    // Per fixture, beside the status somebody typed.
    await expect(page.getByLabel('Receiving data')).toHaveCount(1)
    await expect(
      page.getByLabel('Nothing sent to these addresses since the box started listening')
    ).toHaveCount(1)

    // Bring channel 100 up: the second fixture flips, and never flips back —
    // between cues everything is at zero, and that is not a fault.
    console_.set(1, { 201: 255, 300: 180 })
    await expect(page.getByLabel('Receiving data')).toHaveCount(2, { timeout: 15000 })
    await expect(page.getByText(/2 receiving/)).toBeVisible()

    console_.set(1, { 201: 0, 300: 0 })
    await page.waitForTimeout(1200)
    await expect(page.getByLabel('Receiving data')).toHaveCount(2)

    // Levels reach the drawing: the two fixtures are dimmed differently by
    // what is being sent to them, over their status colour rather than
    // instead of it.
    console_.set(1, { 201: 255, 300: 40 })
    await page.getByRole('button', { name: 'Levels' }).click()
    await page.getByRole('tab', { name: 'Plan' }).click()
    await expect
      .poll(
        async () => {
          const dots = await page.locator('svg[role=img] circle[opacity]').all()
          const values = await Promise.all(dots.map((d) => d.getAttribute('opacity')))
          return values.map(Number).sort((a, b) => a - b)
        },
        { timeout: 15000 }
      )
      .toEqual([expect.closeTo(0.37, 1), expect.closeTo(1, 1)])
  } finally {
    console_.stop()
  }
})

/**
 * The same rig, read through its own GDTF profile.
 *
 * The MVR the importer already handles carries a full profile for every
 * fixture type in it, and this is what that buys: the dimmer instead of the
 * loudest channel, the colour off the wheel, where the head is pointed, and
 * a channel-by-channel readout of what the desk is sending.
 *
 * The profile in `e2e/fixtures/rig.mvr` is generated by
 * `scripts/make-rig-mvr.mjs` — a plausible 16-channel beam, dimmer on 1,
 * shutter on 2, pan on 3/4, tilt on 5/6, colour wheel on 7.
 */
test('a GDTF profile turns the live view from a level meter into a readout', async ({
  browser,
}) => {
  const console_ = new FakeConsole()
  try {
    // Sharpy 1 is at DMX 1. Dimmer out, pan hard over: a head slewing in the
    // dark. Without the profile this is a fixture at 100%.
    await console_.start(1, { 1: 0, 3: 0xff, 4: 0xff })

    const page = await newDevice(browser, 'Profile Tech')
    await openLighting(page)
    await createPlot(page, uniqueName('Profiled Rig'))
    await page.locator('input[type=file]').setInputFiles('e2e/fixtures/rig.mvr')
    await expect(page.getByText(/Imported 4 fixtures/)).toBeVisible()

    // Weight and power come off the profile, so a rig nobody has typed a
    // number into still totals. 4 × 16.4 kg and 4 × 440 W.
    await expect(page.getByText('65.6 kg')).toBeVisible()
    await expect(page.getByText(/1[,.]?760 W/)).toBeVisible()

    // Every head is parked with pan up but its dimmer has never been raised.
    // Judged on the footprint that is four fixtures "receiving"; judged on
    // the dimmer, which is what a profile allows, it is none.
    await expect(page.getByText(/by dimmer/)).toBeVisible({ timeout: 15000 })
    await expect(page.getByLabel('Receiving data')).toHaveCount(0)

    // The readout: pick the first head and read what it is being sent.
    await page
      .getByLabel(/^Purpose/)
      .first()
      .click()
    const channels = page.getByRole('table').last()
    await expect(channels.getByText('Pan', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Levels' }).click()

    // Dimmer to 60%, shutter open, colour wheel to congo, tilt to centre.
    console_.set(1, { 1: 153, 2: 40, 3: 0xc0, 4: 0, 5: 0x80, 6: 0, 7: 25 })

    const row = (name: string) => channels.locator('tr').filter({ hasText: name })
    await expect(row('Dimmer').getByText('60%')).toBeVisible({ timeout: 15000 })
    // 0xC000 of 0xFFFF across −270°→270°.
    await expect(row('Pan').getByText('135°')).toBeVisible()
    await expect(row('Tilt').getByText('0°')).toBeVisible()
    // A named range shows its name, not a percentage of nothing.
    await expect(row('Shutter 1').getByText('Open')).toBeVisible()
    await expect(row('Colour 1').getByText('Congo')).toBeVisible()

    // Push the same channel into its strobe range: the name changes and a
    // real frequency appears, because that range states one.
    console_.set(1, { 1: 153, 2: 200, 3: 0xc0, 4: 0, 5: 0x80, 6: 0, 7: 25 })
    await expect(row('Shutter 1').getByText('Strobe')).toBeVisible({ timeout: 15000 })
    await expect(row('Shutter 1').getByText('18.1 Hz')).toBeVisible()

    // ...and the fixture is now counted as receiving, because its dimmer is
    // up rather than because some channel of it moved.
    await expect(page.getByLabel('Receiving data')).toHaveCount(1)

    // The drawing picks up the wheel colour and the real intensity.
    await page.getByRole('tab', { name: 'Plan' }).click()
    const halo = page.locator('svg[role=img] circle[fill="#0000ff"]')
    await expect(halo).toHaveCount(1)
    // 0.25 + 0.75 × 0.6 — the dimmer, not the pan channel at full.
    await expect
      .poll(async () => {
        const dots = await page.locator('svg[role=img] circle[opacity]').all()
        const values = await Promise.all(dots.map((d) => d.getAttribute('opacity')))
        return values.map(Number).some((value) => Math.abs(value - 0.7) < 0.02)
      })
      .toBe(true)

    // A beam appears in the 3D view once the head is pointed somewhere.
    await page.getByRole('tab', { name: '3D' }).click()
    await expect(page.locator('svg[role=img] polygon')).toHaveCount(4)
  } finally {
    console_.stop()
  }
})

/**
 * A rig that is being sent to and is not moving.
 *
 * Universe synchronisation means a desk sends its levels and then, separately,
 * tells receivers to take them. If that second stream dies, E1.31 §6.2.6 has
 * conforming receivers hold their last look — the desk carries on, every level
 * on the wire carries on changing, and the stage stops. Every other check in
 * the app reads green through all of it.
 *
 * Universe 2 rather than 1, because `everLit` is cumulative per universe for as
 * long as the box is listening and the tests above already use 1.
 */
test('a plot says when the levels it is showing are not what is on stage', async ({ browser }) => {
  const console_ = new FakeConsole()
  try {
    // Sync-addressed to universe 1, which the box does join — so it can tell
    // "nothing is sending sync" from "we would not have heard it".
    console_.syncOn(1)
    await console_.start(2, { 10: 255 })
    console_.startSync()

    const page = await newDevice(browser, 'Sync Tech')
    await openLighting(page)
    await createPlot(page, uniqueName('Synced Rig'))
    await addFixture(page, { purpose: 'LED panel', address: 10, footprint: 1 })

    // The fixture is on universe 2, which the default is not.
    const row = page.locator('tbody tr').last()
    await row.getByLabel(/^Universe/).fill('2')
    await row.getByLabel(/^Universe/).press('Enter')

    // Receiving — and said in the same breath to be queued rather than output.
    await expect(page.getByText(/1 receiving/)).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(/held for sync/)).toBeVisible({ timeout: 15000 })

    // Kill the sync stream and leave the data running. This is the fault.
    console_.stopSync()
    await expect(page.getByText(/frozen on its last look/)).toBeVisible({ timeout: 20000 })

    // The desk is still fine, and the app still says so — the point is that
    // "receiving" and "on stage" have come apart, not that either is false.
    await expect(page.getByText(/1 receiving/)).toBeVisible()

    // And it recovers rather than latching.
    console_.startSync()
    await expect(page.getByText(/held for sync/)).toBeVisible({ timeout: 20000 })
  } finally {
    console_.stop()
  }
})

test('the plot list takes a rig file directly, and the sidebar + starts a plot', async ({
  browser,
}) => {
  const page = await newDevice(browser, uniqueName('Rigger'))

  // Importing from the landing page: no empty plot to create first. The
  // file becomes a plot named after itself, opened, with the import summary
  // shown — the same affordance the patch selector has always had.
  await openLighting(page)
  await page.getByLabel('Import CSV or MVR file').setInputFiles('e2e/fixtures/rig.mvr')
  await expect(page.getByRole('tab', { name: 'Fixtures' })).toBeVisible()
  await expect(page.getByText(/Imported 4 fixtures across/)).toBeVisible()
  await expect(page.getByLabel('Plot title')).toHaveValue('rig')

  // The sidebar's + reads as "create", so it creates: straight to the name
  // form, not just the list.
  await page.getByRole('button', { name: 'New lighting plot' }).click()
  await expect(page.locator('#new-plot-name')).toBeVisible()
})
