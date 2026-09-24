import { expect } from '@playwright/test'
import { textContrast } from './contrast.ts'
import { addAct, test } from './helpers'

/**
 * Contrast guards for both themes.
 *
 * The patch module came from a light-background app, and its CSS carried
 * hardcoded whites that inverted once mapped onto crewbox's themed tokens —
 * the hero text vanished in light theme, the primary button vanished in dark.
 * Both were invisible-but-present, so no functional test caught them. These
 * assert readability directly.
 */

for (const scheme of ['light', 'dark'] as const) {
  test(`patch module text stays readable in ${scheme} theme`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme })
    const page = await context.newPage()
    page.on('pageerror', (e) => {
      throw new Error(`Page error: ${e.message}`)
    })

    await page.goto('/?pin=4242')
    await page.getByLabel('Your name').fill(`Contrast ${scheme}`)
    await page.getByLabel('Your PIN').fill('1234')
    await page.getByRole('button', { name: 'Join' }).click()
    // The composer only exists once the chat shell is up — the join screen
    // carries its own <h1>Crewbox</h1>, so heading text proves nothing here.
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()

    await page.getByRole('button', { name: 'All sheets…' }).click()
    await expect(page.getByRole('heading', { name: 'Patch Sheets' })).toBeVisible()

    // Hero heading and the primary action: the two that were invisible.
    //
    // Scoped to `main`. `h1` alone takes the first one in the document,
    // which is the sidebar brand — a heading in the shell's own colours that
    // was never the thing at risk. This test was written to guard the patch
    // module's hero, and for as long as the selector was unscoped it was
    // measuring something that could not fail.
    expect(await textContrast(page, 'main h1')).toBeGreaterThan(4.5)
    const newSheet = 'main button:has-text("New Sheet")'
    expect(await textContrast(page, newSheet)).toBeGreaterThan(4.5)

    // ...and the grid chrome, whose act header painted text-on-text.
    await page.getByRole('button', { name: '+ New Sheet' }).click()
    await page.locator('#new-sheet-name').fill(`Contrast ${scheme} ${Date.now()}`)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.locator('table')).toBeVisible()

    // A new sheet books nothing on the running order, so the grid has no
    // columns until somebody adds an act — and the act header is what this
    // is checking.
    await addAct(page, 'Headliner')

    expect(await textContrast(page, 'main th:has-text("Headliner")')).toBeGreaterThan(4.5)
    expect(await textContrast(page, 'main th:has-text("CH")')).toBeGreaterThan(4.5)

    await context.close()
  })

  test(`lighting module text stays readable in ${scheme} theme`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme })
    const page = await context.newPage()
    page.on('pageerror', (e) => {
      throw new Error(`Page error: ${e.message}`)
    })

    await page.goto('/?pin=4242')
    await page.getByLabel('Your name').fill(`Lighting ${scheme}`)
    await page.getByLabel('Your PIN').fill('1234')
    await page.getByRole('button', { name: 'Join' }).click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()

    await page.getByRole('button', { name: 'All plots…' }).click()
    await expect(page.getByRole('heading', { name: 'Lighting Plots' })).toBeVisible()

    expect(await textContrast(page, 'h1')).toBeGreaterThan(4.5)
    expect(await textContrast(page, 'button:has-text("New Plot")')).toBeGreaterThan(4.5)

    await page.getByRole('button', { name: '+ New Plot' }).click()
    await page.locator('#new-plot-name').fill(`Lighting ${scheme} ${Date.now()}`)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Fixtures' })).toBeVisible()

    // Group headers, the active tab, and the position heading.
    expect(await textContrast(page, 'h3')).toBeGreaterThan(4.5)
    expect(await textContrast(page, '[role="tab"][aria-selected="true"]')).toBeGreaterThan(4.5)

    // The status pill is a coloured-on-coloured chip in every state, and it's
    // what crew read all night during a systems check.
    await page.locator('main').getByRole('button', { name: '+ Fixture' }).first().click()
    await expect(page.locator('tbody tr')).toHaveCount(1)
    for (let i = 0; i < 4; i++) {
      expect(await textContrast(page, 'tbody [aria-label^="Status of"]')).toBeGreaterThan(4.5)
      await page.locator('tbody [aria-label^="Status of"]').click()
    }

    // The clash warning is the single most important line in the module, and
    // it sits on a tinted row.
    await page.locator('main').getByRole('button', { name: '+ Fixture' }).first().click()
    for (const row of [0, 1]) {
      const address = page.locator('tbody [aria-label^="Address"]').nth(row)
      await address.fill('1')
      await address.press('Enter')
    }
    await expect(page.getByText(/addressing problem/)).toBeVisible()
    expect(await textContrast(page, 'text=/addressing problem/')).toBeGreaterThan(4.5)

    await context.close()
  })

  test(`network audit text stays readable in ${scheme} theme`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme })
    const page = await context.newPage()
    page.on('pageerror', (e) => {
      throw new Error(`Page error: ${e.message}`)
    })

    await page.goto('/?pin=4242')
    await page.getByLabel('Your name').fill(`Audit ${scheme}`)
    await page.getByLabel('Your PIN').fill('1234')
    await page.getByRole('button', { name: 'Join' }).click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()

    await page.getByRole('button', { name: 'Open network audit' }).click()
    await expect(page.getByRole('heading', { name: 'Network', exact: true })).toBeVisible()

    // The verdict chips are coloured-on-tinted — every grade class shares
    // this construction, so one visible instance guards the pattern.
    expect(await textContrast(page, 'h1')).toBeGreaterThan(4.5)
    await expect(page.getByText('Not watched').first()).toBeVisible()
    expect(await textContrast(page, 'text=Not watched')).toBeGreaterThan(4.5)

    // A finding's detail and its fix line, on the row background.
    expect(await textContrast(page, 'text=/connection/')).toBeGreaterThan(4.5)
    expect(await textContrast(page, 'text=/CREWBOX_WATCH/')).toBeGreaterThan(4.5)

    await context.close()
  })

  test(`the admin panel's destructive button stays readable in ${scheme} theme`, async ({
    browser,
  }) => {
    /**
     * Retire is the one button in the panel that takes something away from
     * the whole crew, and it was the least readable thing on the page: the
     * label is `--danger`, which is tuned against `--bg`, sitting on a
     * button whose background is `--bg-hover` — 4.25 in the light theme,
     * under AA. Pressing it once made that worse rather than better, because
     * the confirm state washed the surface with 14% of the same red and
     * dropped it to 3.52. Light theme is what an admin has outdoors.
     */
    const context = await browser.newContext({ colorScheme: scheme })
    const page = await context.newPage()
    page.on('pageerror', (e) => {
      throw new Error(`Page error: ${e.message}`)
    })

    await page.goto('/?pin=4242')
    await page.getByLabel('Your name').fill(`Panel ${scheme}`)
    await page.getByLabel('Your PIN').fill('1234')
    await page.getByRole('button', { name: 'Join' }).click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()

    // #general cannot be retired — deliberately — so the button only exists
    // beside a channel somebody made.
    const channel = `retire-${scheme}`
    await page.getByRole('button', { name: 'New channel' }).click()
    await page.getByPlaceholder('channel-name').fill(channel)
    await page.getByPlaceholder('channel-name').press('Enter')
    await expect(page.getByRole('button', { name: new RegExp(`#${channel}`) })).toBeVisible()

    await page.getByRole('button', { name: 'Admin panel' }).click()
    await page.getByLabel('Admin password').fill('e2e-admin-password')
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect(page.getByRole('heading', { name: 'Crew' })).toBeVisible()

    // Scoped to the row: the sidebar has a channel button of the same name.
    const row = page.locator('.admin-channel', { hasText: channel })
    const inRow = `.admin-channel:has-text("${channel}")`
    await row.getByRole('button', { name: 'Edit' }).click()
    const retire = row.getByRole('button', { name: 'Retire', exact: true })
    await expect(retire).toBeVisible()
    expect(await textContrast(page, `${inRow} .admin-btn.danger`)).toBeGreaterThan(4.5)

    // And the state that actually does it.
    await retire.click()
    const confirm = row.getByRole('button', { name: 'Really retire?' })
    await expect(confirm).toBeVisible()
    expect(await textContrast(page, `${inRow} .admin-btn.danger.confirm`)).toBeGreaterThan(4.5)

    // Go through with it, so the channel this test made does not follow the
    // rest of the suite around the sidebar.
    await confirm.click()
    await expect(page.locator('.admin-channel', { hasText: channel })).toHaveCount(0)

    await context.close()
  })
}

/**
 * The dark flash a light-theme crew member got on every cold open.
 *
 * The theme was applied from JS after the module bundle had loaded, so the
 * dark `:root` painted first — a full dark screen, outdoors, in daylight,
 * for as long as the bundle took over festival Wi-Fi. An inline script in
 * the head sets it before the stylesheet applies.
 */
for (const scheme of ['light', 'dark'] as const) {
  test(`the running order's editor buttons stay readable in ${scheme} theme`, async ({
    browser,
  }) => {
    /**
     * `--accent-text` does not exist and never did, so both of these were
     * `#fff` — white on the amber accent, 1.79:1 in the dark theme, on the
     * two controls somebody presses at a production desk to change the
     * running order everybody else is reading.
     */
    const context = await browser.newContext({ colorScheme: scheme })
    const page = await context.newPage()
    page.on('pageerror', (e) => {
      throw new Error(`Page error: ${e.message}`)
    })

    await page.goto('/?pin=4242')
    await page.getByLabel('Your name').fill(`Sched ${scheme}`)
    await page.getByLabel('Your PIN').fill('1234')
    await page.getByRole('button', { name: 'Join' }).click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()

    await page.goto('/m/schedule')
    await expect(page.getByRole('heading', { name: 'Running order' })).toBeVisible()
    await page.getByRole('button', { name: 'Edit' }).click()

    // The pressed toggle, and the primary action beneath it.
    expect(await textContrast(page, 'button:has-text("Done")')).toBeGreaterThan(4.5)
    expect(await textContrast(page, 'button:has-text("Add act")')).toBeGreaterThan(4.5)

    await context.close()
  })
}

test('a light-theme device never paints dark first', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'light' })
  const page = await context.newPage()

  // Sampled before any module script has run: `document.write`-free, and the
  // inline script is the only thing that could have set this.
  await page.addInitScript(() => {
    document.addEventListener('readystatechange', () => {
      if (document.readyState !== 'interactive') return
      ;(window as unknown as { firstTheme?: string }).firstTheme =
        document.documentElement.dataset.theme
    })
  })
  await page.goto('/')
  await expect(page.getByLabel('Your name')).toBeVisible()

  expect(await page.evaluate(() => (window as { firstTheme?: string }).firstTheme)).toBe('light')
  // And the browser chrome matches the page rather than staying dark.
  expect(
    await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute('content')
    )
  ).toBe('#f5f2ec')

  await context.close()
})

test('a dark-theme device gets the dark chrome', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.getByLabel('Your name')).toBeVisible()
  expect(
    await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute('content')
    )
  ).toBe('#0d1117')
  await context.close()
})
