import { expect, test, type Page } from '@playwright/test'

/**
 * Contrast guards for both themes.
 *
 * The patch module came from a light-background app, and its CSS carried
 * hardcoded whites that inverted once mapped onto crewbox's themed tokens —
 * the hero text vanished in light theme, the primary button vanished in dark.
 * Both were invisible-but-present, so no functional test caught them. These
 * assert readability directly.
 */

const srgb = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance from an "rgb(r, g, b)" string. */
const luminance = (color: string): number => {
  const [r, g, b] = color
    .match(/\d+(\.\d+)?/g)!
    .slice(0, 3)
    .map(Number)
  return 0.2126 * srgb(r!) + 0.7152 * srgb(g!) + 0.0722 * srgb(b!)
}

const contrast = (fg: string, bg: string): number => {
  const [a, b] = [luminance(fg), luminance(bg)]
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Contrast of an element against the nearest ancestor that actually paints a
 * background — transparent backgrounds otherwise report as rgba(0,0,0,0).
 */
async function textContrast(page: Page, selector: string): Promise<number> {
  const { fg, bg } = await page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const fg = getComputedStyle(el).color
      let node: HTMLElement | null = el as HTMLElement
      let bg = 'rgba(0, 0, 0, 0)'
      while (node) {
        const c = getComputedStyle(node).backgroundColor
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) {
          bg = c
          break
        }
        node = node.parentElement
      }
      return { fg, bg }
    })
  return contrast(fg, bg)
}

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
    expect(await textContrast(page, 'h1')).toBeGreaterThan(4.5)
    const newSheet = 'button:has-text("New Sheet")'
    expect(await textContrast(page, newSheet)).toBeGreaterThan(4.5)

    // ...and the grid chrome, whose artist header painted text-on-text.
    await page.getByRole('button', { name: '+ New Sheet' }).click()
    await page.locator('#new-sheet-name').fill(`Contrast ${scheme} ${Date.now()}`)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.locator('table')).toBeVisible()

    expect(await textContrast(page, 'th:has-text("Artist 1")')).toBeGreaterThan(4.5)
    expect(await textContrast(page, 'th:has-text("CH")')).toBeGreaterThan(4.5)

    await context.close()
  })
}
