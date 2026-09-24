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

installBackButton()
installAppLinks()
// The Android app kept its box from last time; this is the page's, which
// may be newer, as on the first start after an update.
holdBoxWifi()

// The outermost net. The shell has its own around the main pane, so a module
// that throws takes only itself down; this catches whatever is left.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary version={APP_VERSION} send={(crash) => sendCrash(crash, sessionToken() ?? '')}>
    <App />
  </ErrorBoundary>
)
