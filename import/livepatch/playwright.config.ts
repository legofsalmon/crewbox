import { defineConfig } from '@playwright/test'

// The e2e suite runs against the real thing: the relay in box mode serving the
// production build, exactly as a festival box would. Run `npm run build` first.
const PORT = 4199

export default defineConfig({
  testDir: 'e2e',
  // Tests share one relay process (unique sheet names isolate them), but run
  // serially so awareness/presence assertions stay deterministic.
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // In sandboxes with a preinstalled Chromium, point PW_CHROMIUM at its
    // executable instead of downloading a matching browser build.
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: {
    command: `PORT=${PORT} DATA_DIR="${process.env.RUNNER_TEMP || '/tmp'}/livepatch-e2e-data" node server/index.cjs`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 15_000,
  },
})
