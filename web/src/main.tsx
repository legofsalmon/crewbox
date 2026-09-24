import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { APP_VERSION } from './lib/pwa.ts'
import { sendCrash } from './lib/reports.ts'
import { sessionToken } from './store.ts'
import './app.css'
import './lib/viewport.ts'
import './shell/title.ts'

// The outermost net. The shell has its own around the main pane, so a module
// that throws takes only itself down; this catches whatever is left.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary version={APP_VERSION} send={(crash) => sendCrash(crash, sessionToken() ?? '')}>
    <App />
  </ErrorBoundary>
)
