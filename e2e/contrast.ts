import type { Page } from '@playwright/test'

/**
 * WCAG contrast of rendered text, shared by the specs that guard both themes
 * (theme.spec.ts, licence.spec.ts). Moved here unchanged from theme.spec.ts.
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
export async function textContrast(page: Page, selector: string): Promise<number> {
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
