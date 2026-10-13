import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { color, cssVar } from '../ds/tokens.js'

/**
 * Contrast guards for the palette itself.
 *
 * e2e/theme.spec.ts already measures what the browser actually paints, which
 * is the real check — but it needs a built app and a browser, so it is not
 * what anyone runs while nudging a colour. This reads the palette straight out
 * of the stylesheet and does the arithmetic, so changing a hex to something
 * unreadable fails in a second rather than in CI.
 *
 * The 4.5 floor is WCAG AA for body text, and it is not academic here: crew
 * read this on a phone in daylight and in a dark FOH tent, often with the
 * screen dimmed to save battery.
 */

const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8')

/**
 * Crewbox's own colour names, resolved through the design system.
 *
 * app.css points each name at a role (`--bg: var(--ds-surface-ground)`), and
 * the vendored tokens.js carries every role's hex per theme. So this reads the
 * mapping crewbox owns and the values the design system owns, and checks the
 * pairs crewbox actually paints.
 */
function tokens(theme: 'dark' | 'light'): Record<string, string> {
  const start = css.indexOf(':root,\n[data-theme] {')
  if (start === -1) throw new Error('no :root, [data-theme] block in app.css')
  const block = css.slice(start, css.indexOf('}', start))
  const byVar = Object.fromEntries(Object.entries(cssVar).map(([path, v]) => [v, path]))
  const found: Record<string, string> = {}
  for (const [, name, role] of block.matchAll(/(--[\w-]+):\s*var\((--ds-[\w-]+)\);/g)) {
    const path = byVar[role]
    if (!path?.startsWith('color.')) throw new Error(`${name} points at ${role}, not a colour role`)
    let value: unknown = color[theme]
    for (const key of path.split('.').slice(1)) value = (value as Record<string, unknown>)[key]
    if (typeof value === 'object' && value) value = (value as Record<string, unknown>).default
    found[name] = value as string
  }
  return found
}

const srgb = (c: number): number => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

const luminance = (hex: string): number => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`not a plain hex colour: ${hex}`)
  const n = parseInt(m[1], 16)
  return 0.2126 * srgb((n >> 16) & 255) + 0.7152 * srgb((n >> 8) & 255) + 0.0722 * srgb(n & 255)
}

const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)]
  const [hi, lo] = x > y ? [x, y] : [y, x]
  return (hi + 0.05) / (lo + 0.05)
}

const themes = {
  dark: tokens('dark'),
  light: tokens('light'),
}

describe.each(Object.entries(themes))('%s theme', (_name, t) => {
  /** Every surface text can land on. */
  const surfaces = ['--bg', '--bg-raised', '--bg-hover', '--bg-active'] as const

  it.each(surfaces)('body text is readable on %s', (surface) => {
    expect(contrast(t['--text'], t[surface])).toBeGreaterThan(4.5)
  })

  it.each(surfaces)('muted text is readable on %s', (surface) => {
    // Muted carries real content — timestamps, channel topics, the "who
    // shared this" line — so it gets the same floor as body text, not the 3:1
    // large-text allowance.
    expect(contrast(t['--text-muted'], t[surface])).toBeGreaterThan(4.5)
  })

  it('accent text is readable on the base surface', () => {
    expect(contrast(t['--accent'], t['--bg'])).toBeGreaterThan(4.5)
  })

  it('labels on an accent button are readable', () => {
    // The pairing that broke before: a primary button whose text vanished.
    expect(contrast(t['--accent-contrast'], t['--accent'])).toBeGreaterThan(4.5)
    expect(contrast(t['--accent-contrast'], t['--accent-strong'])).toBeGreaterThan(4.5)
  })

  it('danger, warning and ok read against the base surface', () => {
    expect(contrast(t['--danger'], t['--bg'])).toBeGreaterThan(4.5)
    expect(contrast(t['--warn-ink'], t['--bg'])).toBeGreaterThan(4.5)
    expect(contrast(t['--ok'], t['--bg'])).toBeGreaterThan(4.5)
  })

  it('danger and warning read on a button', () => {
    // A destructive button's label sits on --bg-hover, not --bg.
    expect(contrast(t['--danger'], t['--bg-hover'])).toBeGreaterThan(4.5)
    expect(contrast(t['--warn-ink'], t['--bg-hover'])).toBeGreaterThan(4.5)
  })

  it('labels on a red or amber fill are readable', () => {
    expect(contrast(t['--danger-on'], t['--danger-fill'])).toBeGreaterThan(4.5)
    expect(contrast(t['--warn-on'], t['--warn'])).toBeGreaterThan(4.5)
  })

  it('gives every surface its own step', () => {
    // Two surfaces at the same luminance means a panel edge disappears.
    const steps = surfaces.map((s) => luminance(t[s]))
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).not.toBeCloseTo(steps[i - 1], 3)
    }
  })

  it('deepens with interaction, in whichever direction the theme runs', () => {
    // Not "all four go one way" — that is only true of a dark theme. A light
    // theme correctly floats cards *lighter* than the page while a press goes
    // *darker*. What must hold in both is that hover and active move away
    // from the resting surface, and active moves further than hover, or a
    // press reads as weaker than a hover.
    const [bg, , hover, active] = surfaces.map((s) => luminance(t[s]))
    const towardsDark = hover < bg
    expect(towardsDark ? active < hover : active > hover).toBe(true)
  })
})

describe.each(Object.entries(themes))('%s surfaces', (_name, t) => {
  it.each(['--bg', '--bg-raised', '--bg-hover', '--bg-active'])('%s is neutral', (name) => {
    // The design system's chrome is never tinted: a tinted chrome shifts what
    // the eye reads as white. (Crewbox's dark theme was navy until 2026-10.)
    const n = parseInt(t[name].slice(1), 16)
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(8)
  })
})
