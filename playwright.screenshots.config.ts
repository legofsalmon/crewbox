import { defineConfig } from '@playwright/test'

/**
 * The docs screenshot run — `npm run docs:shots`.
 *
 * Its own config and server, never shared with the e2e suite: screenshots
 * need FIXED names ("Main Stage", not "Main Stage m3kx91"), a fixed admin
 * password, and CREWBOX_WATCH on so the network module's media card is
 * watched rather than the e2e suite's honest "Not watched" state.
 *
 * The run is serial by design — one seed test builds the event (channels,
 * a scripted conversation, the imported festival fixtures), then capture
 * tests photograph it area by area into site/docs/img/<scene>-{dark,light}.png.
 * `build-docs.mjs` validates every shot reference against those files, so a
 * renamed scene fails the docs build rather than shipping a broken image.
 */

// No timestamp: the path shows up inside the This-box screenshot's fix
// lines, so it has to read cleanly. npm run docs:shots wipes it first.
const dataDir = `${process.env.RUNNER_TEMP ?? '/tmp'}/crewbox-shots-data`

export default defineConfig({
  testDir: 'e2e/screenshots',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4298',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    ...(process.env.PW_CHROMIUM
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } }
      : {}),
  },
  webServer: {
    command: 'npm run start -w server',
    url: 'http://localhost:4298/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      CREWBOX_PORT: '4298',
      DATA_DIR: dataDir,
      WEB_DIST: `${process.cwd()}/web/dist`,
      EVENT_PIN: '4242',
      CREWBOX_DMX: 'sacn',
      CREWBOX_DMX_IFACE: '127.0.0.1',
      CREWBOX_DMX_UNIVERSES: '1-2',
      CREWBOX_WATCH: '1',
      ADMIN_PASSWORD: 'shots-admin-password',
      JOIN_RATE_LIMIT: '1000',
      CREWBOX_MODULES: 'patch,lighting,network',
      LIVEKIT_URL: '',
    },
  },
})
