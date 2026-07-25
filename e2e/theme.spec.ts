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

type Rgba = [number, number, number, number]

/**
 * Parse a computed colour into 0–255 channels plus alpha.
 *
 * Two notations turn up, and they use different scales: `rgb()`/`rgba()`
 * give 0–255, while `color(srgb …)` — which is what Chromium resolves
 * `color-mix()` to — gives 0–1. Reading the second as the first makes every
 * mixed colour look nearly black, so a themed chip reports a contrast
 * failure that isn't there.
 */
const parseColor = (color: string): Rgba => {
  const parts = (color.match(/[\d.]+/g) ?? []).map(Number)
  const [a = 0, b = 0, c = 0] = parts
  const alpha = parts[3] ?? 1
  return color.startsWith('color(') ? [a * 255, b * 255, c * 255, alpha] : [a, b, c, alpha]
}

/** WCAG relative luminance. */
const luminance = (color: string | Rgba): number => {
  const [r, g, b] = typeof color === 'string' ? parseColor(color) : color
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)
}

const contrast = (fg: string | Rgba, bg: string | Rgba): number => {
  const [a, b] = [luminance(fg), luminance(bg)]
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

/** Composite `src` over an opaque `dst`, the way the browser paints it. */
const over = (src: string, dst: Rgba): Rgba => {
  const [sr, sg, sb, sa] = parseColor(src)
  const blend = (s: number, d: number) => s * sa + d * (1 - sa)
  return [blend(sr, dst[0]), blend(sg, dst[1]), blend(sb, dst[2]), 1]
}

/**
 * Contrast of an element against what is actually painted behind it.
 *
 * Backgrounds are collected up the tree until an opaque one is found, then
 * composited back down. Reading only the nearest non-transparent background
 * gets translucent layers badly wrong — a `color-mix(…, transparent)` chip
 * reports its raw pigment rather than the light surface it sits on, which
 * looks like a contrast failure when the rendered result is fine.
 */
async function textContrast(page: Page, selector: string): Promise<number> {
  const { fg, layers } = await page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const fg = getComputedStyle(el).color
      const layers: string[] = []
      let node: HTMLElement | null = el as HTMLElement
      while (node) {
        const c = getComputedStyle(node).backgroundColor
        const alpha = Number((c.match(/[\d.]+/g) ?? [])[3] ?? 1)
        if (c && alpha > 0) {
          layers.push(c)
          if (alpha === 1) break
        }
        node = node.parentElement
      }
      return { fg, layers }
    })

  // Innermost layer is first; paint from the opaque backmost one forwards.
  const bg = layers.reduceRight<Rgba>((dst, src) => over(src, dst), [255, 255, 255, 1])
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
}
