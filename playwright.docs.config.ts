import { defineConfig } from '@playwright/test'

/**
 * The docs site's own tests — `npm run docs:test:ui`.
 *
 * It serves site/ with preview.mjs, which maps clean URLs exactly the way
 * Vercel does, so what the tests click is what a reader gets. Separate from
 * the app's e2e config because there is no box involved at all: this is a
 * static site, and the only moving parts are docs.js and docs.css.
 */
export default defineConfig({
  testDir: 'e2e/docs',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:4311',
    ...(process.env.PW_CHROMIUM
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } }
      : {}),
  },
  webServer: {
    command: 'node site/preview.mjs',
    url: 'http://localhost:4311/docs',
    reuseExistingServer: false,
    timeout: 15_000,
    env: { PORT: '4311' },
  },
})
