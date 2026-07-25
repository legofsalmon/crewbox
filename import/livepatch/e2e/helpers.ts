import { expect, type Browser, type Page } from '@playwright/test'

/** Unique sheet name per test so tests sharing the relay never collide. */
export const uniqueName = (base: string) =>
  `${base} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

/** A fresh "device": isolated storage, browsing to the box. */
export const newDevice = async (browser: Browser): Promise<Page> => {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`)
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Live Patch' })).toBeVisible()
  return page
}

export const createSheet = async (page: Page, name: string) => {
  await page.getByRole('button', { name: '+ New Sheet' }).click()
  await page.locator('#new-sheet-name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('table')).toBeVisible()
}

export const openSheetByName = async (page: Page, name: string) => {
  await page.getByText(name).click()
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

export const syncChip = (page: Page) => page.locator('button[title="Sync settings"]')

export const configureSync = async (page: Page, url: string, token: string) => {
  await syncChip(page)
    .or(page.getByRole('button', { name: '⚙ Sync settings' }))
    .first()
    .click()
  await page.locator('#sync-url').fill(url)
  await page.locator('#sync-token').fill(token)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
}
