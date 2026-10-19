import { color, font, palette, radius } from '../../web/src/ds/tokens.js'

/**
 * Chrome for the two pages the box renders itself: /setup and /connect.
 *
 * These load before the web app does — /connect is meant to survive on a
 * spare screen with nothing else running, and /setup runs before anyone has
 * even joined — so they have no stylesheet to import. They take the shared
 * design system's roles as values instead, from the copy the web app
 * vendors (web/src/ds/tokens.js), so the pages and the app cannot drift
 * apart and a `npm run ds:sync` moves both. Both themes, following the
 * device, as the app does on a phone that has never chosen.
 */

/** Minimal HTML escaping for server-rendered pages. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * The pages' own colour names, pointed at the roles as web/src/app.css does
 * for the app, written out as values for one theme.
 */
const roles = (theme: 'dark' | 'light'): string => {
  const t = color[theme]
  return Object.entries({
    bg: t.surface.ground,
    field: t.surface.inset,
    ink: t.ink.primary,
    // Read, on the page and under a field: secondary, not tertiary.
    muted: t.ink.secondary,
    line: t.line.subtle,
    'field-line': t.line.control,
    accent: t.accent.default,
    'accent-hover': t.accent.hover,
    'accent-on': t.accent.on,
    link: t.accent.ink,
    focus: t.focus,
    'warn-ink': t.warn.ink,
    'warn-soft': t.warn.soft,
    'bad-ink': t.bad.ink,
    'bad-soft': t.bad.soft,
  })
    .map(([name, value]) => `--${name}: ${value};`)
    .join(' ')
}

/** The touch density's corners: these pages are opened on a phone. */
export const CONTROL_RADIUS = `${radius.touch.control}px`
export const PANEL_RADIUS = `${radius.touch.panel}px`

/**
 * A QR code's light modules and quiet zone. Content, not chrome: a scanner
 * needs dark on light in either theme, so it stays white in the dark one.
 */
export const QR_PAPER = palette.neutral['100']

export const PAGE_CSS = `
  :root { ${roles('dark')} color-scheme: dark; }
  @media (prefers-color-scheme: light) {
    :root { ${roles('light')} color-scheme: light; }
  }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: var(--bg); color: var(--ink); font-family: ${font.stack.sans};
         font-variant-numeric: tabular-nums; text-align: center; }
  .card { padding: 32px; max-width: 30rem; width: 100%; box-sizing: border-box; }
  h1 { letter-spacing: 0.06em; margin: 0 0 4px; }
  .meta { color: var(--muted); margin-top: 14px; font-size: 15px; }
  a { color: var(--link); }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
`
