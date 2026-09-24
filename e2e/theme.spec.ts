import { expect } from '@playwright/test'
import { textContrast } from './contrast.ts'
import { addAct, appWithDiscovery, scanWillGive, test } from './helpers'

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
    // The way in, which the rule for every panel button used to paint over.
    expect(await textContrast(page, '.admin-btn.admin-btn-primary')).toBeGreaterThan(4.5)
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect(page.getByRole('heading', { name: 'Crew' })).toBeVisible()
    // The line saying whether the apps can find the box is read, not a
    // footnote: it started out in the panel's faint grey, 3.5:1.
    expect(await textContrast(page, '.admin-status')).toBeGreaterThan(4.5)

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

for (const scheme of ['light', 'dark'] as const) {
  test(`the phone's own boxes stay readable in ${scheme} theme`, async ({ browser }) => {
    // In the app, where "Your boxes" is always offered, with a second event
    // on the phone holding a show-log entry it never sent: the row that says
    // so, and the warning that forgetting it loses the entry for good.
    const context = await browser.newContext({ colorScheme: scheme })
    await context.addInitScript(() => {
      ;(window as unknown as { Capacitor: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: {},
      }
    })
    const page = await context.newPage()
    page.on('pageerror', (e) => {
      throw new Error(`Page error: ${e.message}`)
    })
    await page.goto('/?server=http://localhost:4299&pin=4242')
    await page.getByLabel('Your name').fill(`Boxes ${scheme}`)
    await page.getByLabel('Your PIN').fill('1234')
    await page.getByRole('button', { name: 'Join' }).click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()

    await page.evaluate(() => {
      const events = JSON.parse(localStorage.getItem('crewbox:boxes') ?? '[]') as unknown[]
      const lastWeek = Date.now() - 3 * 24 * 60 * 60_000
      events.push({
        id: 'harbour',
        name: 'Harbour Tour',
        origin: 'http://10.0.0.9',
        seenAt: lastWeek,
        // Its box came back as this one, so its work can come here.
        replacedBy: localStorage.getItem('crewbox:db-epoch'),
      })
      localStorage.setItem('crewbox:boxes', JSON.stringify(events))
      localStorage.setItem('crewbox@harbour:token', 'a-sign-in')
      localStorage.setItem(
        'crewbox@harbour:incident-outbox',
        JSON.stringify([
          {
            clientMsgId: 'q1',
            kind: 'note',
            severity: 'note',
            body: 'Barrier moved',
            at: 1,
            stage: 'Main',
            actId: '',
            actName: '',
          },
        ])
      )
    })
    await page.reload()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()

    // Asked whether to bring that work across.
    const offer = page.getByRole('dialog', { name: 'Bring your work across?' })
    await expect(offer).toContainText('1 unsent show-log entry')
    for (const part of ['p', '.move-items li', '.confirm-go', '.confirm-cancel']) {
      expect(await textContrast(page, `.confirm-panel ${part}`), part).toBeGreaterThan(4.5)
    }
    await offer.getByRole('button', { name: 'Not now' }).click()

    expect(await textContrast(page, '.sidebar-boxes')).toBeGreaterThan(4.5)
    await page.getByRole('button', { name: 'Your boxes', exact: true }).click()
    const row = '.boxes-row:has-text("Harbour Tour")'
    await expect(page.locator(row)).toContainText('1 unsent')
    for (const part of ['.boxes-name', '.boxes-detail', '.boxes-unsent', '.admin-btn']) {
      expect(await textContrast(page, `${row} ${part}`), part).toBeGreaterThan(4.5)
    }
    expect(await textContrast(page, `${row} .boxes-move span`)).toBeGreaterThan(4.5)
    expect(await textContrast(page, `${row} .boxes-move button`)).toBeGreaterThan(4.5)
    expect(await textContrast(page, '.boxes-badge')).toBeGreaterThan(4.5)
    expect(await textContrast(page, '.boxes-address label')).toBeGreaterThan(4.5)
    expect(await textContrast(page, '.boxes-address .hint')).toBeGreaterThan(4.5)

    await page.locator(row).getByRole('button', { name: 'Forget Harbour Tour' }).click()
    await expect(page.locator('.boxes-lost')).toBeVisible()
    expect(await textContrast(page, '.boxes-lost')).toBeGreaterThan(4.5)

    await context.close()
  })

  test(`a direct message's banner stays readable on a phone in ${scheme} theme`, async ({
    browser,
  }) => {
    const join = async (name: string, phone: boolean) => {
      const context = await browser.newContext({
        colorScheme: scheme,
        ...(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true } : {}),
      })
      const page = await context.newPage()
      page.on('pageerror', (e) => {
        throw new Error(`Page error: ${e.message}`)
      })
      await page.goto('/?pin=4242')
      await page.getByLabel('Your name').fill(name)
      await page.getByLabel('Your PIN').fill('1234')
      await page.getByRole('button', { name: 'Join' }).click()
      await expect(page.getByPlaceholder(/Message/)).toBeVisible()
      return { context, page }
    }
    const name = `Banner ${scheme} ${Date.now().toString(36)}`
    const phone = await join(name, true)
    const desk = await join(`Desk ${scheme} ${Date.now().toString(36)}`, false)
    await desk.page.getByRole('button', { name: `Message ${name}` }).click()
    const toPhone = desk.page.getByPlaceholder(`Message ${name}`)
    await toPhone.fill('Can you come to FOH before doors?')
    await toPhone.press('Enter')

    const banner = phone.page.locator('.alert-banner')
    await expect(banner).toBeVisible()
    for (const part of ['.alert-banner-title', '.alert-banner-body', '.alert-banner-close']) {
      expect(await textContrast(phone.page, part), part).toBeGreaterThan(4.5)
    }
    // On the screen, clear of both edges.
    const box = (await banner.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(8)
    expect(box.x + box.width).toBeLessThanOrEqual(390 - 8)

    await phone.context.close()
    await desk.context.close()
  })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`scanning the join poster stays readable in ${scheme} theme`, async ({ browser }) => {
    const page = await appWithDiscovery(browser, 'android', [], { colorScheme: scheme })
    await page.goto('/')
    await scanWillGive(
      page,
      { result: 'scanned', text: 'http://127.0.0.1:4299/?pin=4242' },
      { result: 'denied' }
    )
    const scan = page.getByRole('button', { name: 'Scan the join poster' })
    expect(await textContrast(page, '.join-scan > .admin-btn')).toBeGreaterThan(4.5)

    await scan.click()
    await expect(page.locator('.join-scan-note')).toBeVisible()
    expect(await textContrast(page, '.join-scan-note')).toBeGreaterThan(4.5)

    await scan.click()
    await expect(page.locator('.join-settings')).toBeVisible()
    for (const part of ['.join-error', '.join-settings']) {
      expect(await textContrast(page, part), part).toBeGreaterThan(4.5)
    }
  })

  test(`the boxes on this Wi-Fi stay readable in ${scheme} theme`, async ({ browser }) => {
    // The iPhone app's join screen: the line asking before the first search,
    // then a box, one claiming the same event, and one nobody has set up.
    const config = (await (await fetch('http://localhost:4299/api/config')).json()) as {
      eventId: string
    }
    const box = (name: string, port: number, txt: Record<string, string>) => ({
      name,
      addresses: ['127.0.0.1'],
      port,
      txt: { txtvers: '1', ...txt },
    })
    const page = await appWithDiscovery(
      browser,
      'ios',
      [
        box('Main Stage Crew', 4299, { id: config.eventId, name: 'Main Stage Crew', setup: '1' }),
        box('Main Stage Crew (2)', 4398, {
          id: config.eventId,
          name: 'Main Stage Crew',
          setup: '1',
        }),
        box('crewbox', 4396, { id: 'freshbox', setup: '0' }),
      ],
      { colorScheme: scheme }
    )
    await page.goto('/')
    const nearby = '.nearby'
    await expect(page.locator(`${nearby} .nearby-note`)).toContainText('Your iPhone will ask')
    for (const part of ['.nearby-title', '.nearby-note', '> .admin-btn']) {
      expect(await textContrast(page, `${nearby} ${part}`), part).toBeGreaterThan(4.5)
    }

    await page.getByRole('button', { name: 'Find boxes' }).click()
    const row = `${nearby} .nearby-row:has-text("127.0.0.1:4299")`
    await expect(page.locator(row)).toContainText('Another box here has the same name')
    for (const part of ['.boxes-name', '.boxes-detail', '.nearby-warn', '.admin-btn']) {
      expect(await textContrast(page, `${row} ${part}`), part).toBeGreaterThan(4.5)
    }
    const fresh = `${nearby} .nearby-row:has-text("127.0.0.1:4396")`
    expect(await textContrast(page, `${fresh} .nearby-warn`)).toBeGreaterThan(4.5)

    await page.locator(row).getByRole('button', { name: 'Pick Main Stage Crew' }).click()
    await expect(page.locator(`${row} .boxes-badge`)).toHaveText('Picked')
    expect(await textContrast(page, `${row} .boxes-badge`)).toBeGreaterThan(4.5)
  })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`what the join screen says went wrong stays readable in ${scheme} theme`, async ({
    browser,
  }) => {
    // Somebody reading this is stuck outside the event, often in daylight.
    // The same box says what went wrong on the Boxes screen, in the feedback
    // and delete-account dialogs, and when moving work across.
    const page = await appWithDiscovery(browser, 'ios', [], { colorScheme: scheme })
    await page.goto('/')
    // A name without https://, which the iPhone app refuses before sending
    // anything anywhere: an error with no box involved.
    await page.getByLabel('Crew server').fill('crew.example.org')
    await page.getByLabel('Your name').fill(`Contrast ${scheme}`)
    await page.getByLabel('Event PIN').fill('4242')
    await page.getByLabel('Your PIN').fill('1234')
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(page.locator('.join-error')).toContainText('over HTTPS')
    expect(await textContrast(page, '.join-error')).toBeGreaterThan(4.5)
  })
}
