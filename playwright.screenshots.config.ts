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
  // Two servers: the box, and a fake LED processor for it to read. No
  // NovaStar hardware has ever been in front of this module, so the choice
  // for the video shot is between photographing an empty pane and
  // photographing a simulator. The simulator serves the documented endpoints
  // (scripts/coex-sim.mjs) and the docs page says outright that the field
  // names behind it are unconfirmed.
  webServer: [
    {
      command: 'node scripts/coex-sim.mjs',
      url: 'http://127.0.0.1:8001/api/v1/device',
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
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
        // Pinned for the same two reasons as the password above. The This-box
        // shot now prints the desk control key, and a box left to mint its own
        // would put a fresh 32-character string in a committed PNG on every
        // run — churn in the repo, and a credential-shaped thing published on
        // a public site. This one is plainly an illustration.
        CREWBOX_CONTROL_KEY: 'shots-control-key',
        JOIN_RATE_LIMIT: '1000',
        CREWBOX_MODULES: 'schedule,patch,lighting,incident,video,network',
        // Loopback, so the video module's sweep button is offered rather than
        // showing its "no video adapter" state. Nothing sweeps during a shot
        // run — the scene photographs a processor added by address.
        CREWBOX_VIDEO_IFACE: '127.0.0.1',
        LIVEKIT_URL: '',
      },
    },
  ],
})
