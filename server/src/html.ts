/**
 * Chrome for the two pages the box renders itself: /setup and /connect.
 *
 * These load before the web app does — /connect is meant to survive on a
 * spare screen with nothing else running, and /setup runs before anyone has
 * even joined — so they can't use the app's CSS custom properties. The
 * literal colours here are the dark-theme values from web/src/app.css,
 * copied deliberately rather than imported, and kept in one place so the two
 * pages can't drift apart.
 */

/** Minimal HTML escaping for server-rendered pages. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export const PAGE_CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #12100e; color: #f2eee7; font-family: system-ui, sans-serif; text-align: center; }
  .card { padding: 32px; max-width: 30rem; width: 100%; box-sizing: border-box; }
  h1 { letter-spacing: 0.06em; margin: 0 0 4px; }
  .meta { color: #a29a8c; margin-top: 14px; font-size: 15px; }
  a { color: #f5b73e; }
`
