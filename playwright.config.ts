import { defineConfig } from '@playwright/test'

/**
 * E2E against the real crewbox server in box mode: built web app served by
 * the Node server, chat WS, docs relay, patch module enabled. Run
 * `npm run build -w web` first — the server serves web/dist.
 *
 * In a sandbox with a preinstalled Chromium, set PW_CHROMIUM to its path.
 */
const dataDir = `${process.env.RUNNER_TEMP ?? '/tmp'}/crewbox-e2e-data-${Date.now()}`

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:4299',
    ...(process.env.PW_CHROMIUM
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } }
      : {}),
  },
  webServer: {
    command: 'npm run start -w server',
    url: 'http://localhost:4299/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      CREWBOX_PORT: '4299',
      DATA_DIR: dataDir,
      WEB_DIST: `${process.cwd()}/web/dist`,
      EVENT_PIN: '4242',
      CREWBOX_MODULES: 'patch',
      LIVEKIT_URL: '',
    },
  },
})
