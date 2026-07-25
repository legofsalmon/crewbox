import { useStore } from '../store.ts'

/**
 * Opens the sidebar drawer on mobile. Hidden above 900px, where the sidebar
 * is always on screen (see `.hamburger` in app.css).
 *
 * Every module's top-level views must render this at the start of their
 * header. Navigating to a module closes the drawer, so a pane without one
 * strands a phone user inside it with no way back to chat or to any other
 * module — the browser back button is not a UI.
 */
export default function DrawerButton() {
  const setSidebarOpen = useStore((s) => s.setSidebarOpen)
  return (
    <button
      className="icon-btn hamburger"
      aria-label="Open channels"
      onClick={() => setSidebarOpen(true)}
    >
      {/* Drawn, not the ☰ glyph — the iOS webview font lacks it (tofu box). */}
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
        <path
          d="M4 6h16M4 12h16M4 18h16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )
}
