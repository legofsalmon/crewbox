import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test'

/** Unique names so tests sharing one server never collide. */
export const uniqueName = (base: string) =>
  `${base} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let crewCounter = 0

/**
 * Every context `newDevice` opened, so it can be shut again.
 *
 * The suite runs serially in one browser, and most specs never closed the
 * devices they made — so by the end of a run thirty-odd contexts were still
 * open, each holding a live page, a WebSocket to the box and an IndexedDB
 * connection, all still receiving. That is the "flakiness" the patch
 * changeover spec papers over with a twenty-second timeout: not a race in
 * the app, a browser doing the work of thirty idle crew phones.
 */
const openContexts: BrowserContext[] = []

/**
 * `test`, with an automatic fixture that closes those contexts.
 *
 * Specs import this rather than Playwright's own, so no spec has to remember
 * — and a spec that closes its own device early is unaffected, because
 * closing a closed context is a no-op.
 */
export const test = base.extend<{ closeDevices: void }>({
  closeDevices: [
    // eslint-disable-next-line no-empty-pattern -- Playwright's fixture shape.
    async ({}, use) => {
      await use()
      await Promise.all(openContexts.splice(0).map((context) => context.close().catch(() => {})))
    },
    { auto: true },
  ],
})

/**
 * A fresh "device": isolated storage (own IndexedDB/localStorage), joined
 * to the event as a new crew member through the real join flow.
 */
export const newDevice = async (browser: Browser, crewName?: string): Promise<Page> => {
  const context = await browser.newContext()
  openContexts.push(context)
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`)
  })
  await page.goto('/')
  const name = crewName ?? `Crew${Date.now().toString(36).slice(-4)}${crewCounter++}`
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Event PIN').fill('4242')
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  // Wait for the composer, not the brand: the join screen has its own
  // <h1>Crewbox</h1>, so heading text alone can pass before login completes.
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  return page
}

/** Open the patch module's sheet selector from the sidebar. */
export const openPatch = async (page: Page) => {
  await page.getByRole('button', { name: 'All sheets…' }).click()
  await expect(page.getByRole('heading', { name: 'Patch Sheets' })).toBeVisible()
}

export const createSheet = async (page: Page, name: string) => {
  await page.getByRole('button', { name: '+ New Sheet' }).click()
  await page.locator('#new-sheet-name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('table')).toBeVisible()
  // A new sheet has no columns. It used to seed an "Act 1" onto the event's
  // running order, which put a band nobody had booked in front of every
  // department on the box — so the act comes from the lineup now, the way a
  // real one does. Named, because the grid's cells are labelled by act.
  await addAct(page, 'Act 1')
}

/** Put an act on the running order from the sheet's own Lineup popover. */
export const addAct = async (page: Page, name: string) => {
  // Exact: the empty grid's own prompt reads "add one in the lineup".
  await page.getByRole('button', { name: 'Lineup', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Lineup' })).toBeVisible()
  await page.getByRole('button', { name: '+ Add Act' }).click()
  const field = page.getByLabel('Act name').last()
  await field.fill(name)
  await field.blur()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog', { name: 'Lineup' })).toBeHidden()
}

export const openSheetByName = async (page: Page, name: string) => {
  // Scope to the main pane — the sidebar's Patch Sheets section lists the
  // same title, and two matches trip Playwright's strict mode.
  await page.locator('main').getByText(name).first().click()
  await expect(page.locator('table')).toBeVisible()
}

export const cell = (page: Page, act: string, channel: string, field: string) =>
  page.getByLabel(`${act}, channel ${channel}, ${field}`)

export const commitCell = async (
  page: Page,
  act: string,
  channel: string,
  field: string,
  value: string
) => {
  const input = cell(page, act, channel, field)
  await input.click()
  await input.fill(value)
  await input.press('Enter')
}
