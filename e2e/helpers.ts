import { expect, type Browser, type Page } from '@playwright/test'

/** Unique names so tests sharing one server never collide. */
export const uniqueName = (base: string) =>
  `${base} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let crewCounter = 0

/**
 * A fresh "device": isolated storage (own IndexedDB/localStorage), joined
 * to the event as a new crew member through the real join flow.
 */
export const newDevice = async (browser: Browser, crewName?: string): Promise<Page> => {
  const context = await browser.newContext()
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
}

export const openSheetByName = async (page: Page, name: string) => {
  // Scope to the main pane — the sidebar's Patch Sheets section lists the
  // same title, and two matches trip Playwright's strict mode.
  await page.locator('main').getByText(name).first().click()
  await expect(page.locator('table')).toBeVisible()
}

export const cell = (page: Page, artist: string, channel: string, field: string) =>
  page.getByLabel(`${artist}, channel ${channel}, ${field}`)

export const commitCell = async (
  page: Page,
  artist: string,
  channel: string,
  field: string,
  value: string
) => {
  const input = cell(page, artist, channel, field)
  await input.click()
  await input.fill(value)
  await input.press('Enter')
}
