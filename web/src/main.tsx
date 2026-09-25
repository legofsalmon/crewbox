import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { APP_VERSION } from './lib/pwa.ts'
import { sendCrash } from './lib/reports.ts'
import { sessionToken } from './store.ts'
import './app.css'
import './lib/viewport.ts'
import './shell/title.ts'
import { installBackButton } from './shell/back.ts'
import { installAppLinks } from './lib/appLinks.ts'
import { holdBoxWifi } from './lib/server.ts'
import { loadSessions } from './lib/sessions.ts'
import { keepAppCopy, restoreFromApp } from './lib/appCopy.ts'

installBackButton()
installAppLinks()
// The Android app kept its box from last time; this is the page's, which
// may be newer, as on the first start after an update.
holdBoxWifi()

function render(): void {
  // The outermost net. The shell has its own around the main pane, so a module
  // that throws takes only itself down; this catches whatever is left.
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary version={APP_VERSION} send={(crash) => sendCrash(crash, sessionToken() ?? '')}>
      <App />
    </ErrorBoundary>
  )
}

// In the apps the sign-ins are the app's, and the store reads one as it
// boots, on the first render (lib/sessions.ts). Before them, whatever of the
// phone's events a wipe of the web view's storage took comes back from the
// app's copy, which may mean loading the page again (lib/appCopy.ts). In a
// browser all of this is at once.
void restoreFromApp()
  .then((vouched) => loadSessions(vouched))
  .then(render, render)
  .then(keepAppCopy)
