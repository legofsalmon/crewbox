import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Browser, type Page } from '@playwright/test'
import { test, uniqueName } from './helpers'

/**
 * A crewbox://join link, from a message or a phone's join page, opening the app.
 *
 * The apps claim the scheme (native/ios Info.plist, native/android manifest),
 * and Capacitor's App plugin hands the page the link that started the app or
 * one tapped while it runs. Everything after that is the page's, and is what
 * these stand in for: a link fills in the join form as scanning the poster
 * does, and a phone signed in elsewhere is offered the link's box, with
 * nothing sent anywhere until somebody presses Join or Connect.
 */

const SERVER_DIR = join(process.cwd(), 'server')

/** A second box, on its own port and database, as boxes.spec.ts starts them. */
async function startBox(port: number, pin: string) {
  const dir = mkdtempSync(join(tmpdir(), 'crewbox-e2e-box-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CREWBOX_PORT: String(port),
      DATA_DIR: dir,
      WEB_DIST: join(process.cwd(), 'web/dist'),
      EVENT_PIN: pin,
      ADMIN_PASSWORD: 'e2e-admin-password',
      JOIN_RATE_LIMIT: '1000',
      LIVEKIT_URL: '',
    },
  })
  const address = `127.0.0.1:${port}`
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const deadline = Date.now() + 30_000
  for (;;) {
    const up = await fetch(`http://${address}/api/health`).then(
      (res) => res.ok,
      () => false
    )
    if (up) break
    if (Date.now() > deadline) throw new Error(`box on ${address} did not start`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return {
    address,
    stop: async () => {
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        // Already gone.
      }
      await exited
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * The Android app, with Capacitor's App plugin as far as links go: the link
 * that started it, which it goes on answering for as the real one does, and
 * `__openUrl` for a link tapped while it runs.
 */
async function appWithLinks(browser: Browser, launch?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.addInitScript((launch) => {
    const w = window as unknown as Record<string, unknown>
    const listeners: Record<string, (event: unknown) => void> = {}
    w.__openUrl = (url: string) => listeners.appUrlOpen?.({ url })
    w.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        App: {
          addListener: (event: string, listener: (event: unknown) => void) => {
            listeners[event] = listener
            return Promise.resolve({ remove: async () => {} })
          },
          minimizeApp: async () => {},
          getLaunchUrl: async () => (launch ? { url: launch } : undefined),
        },
      },
    }
  }, launch)
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`)
  })
  return page
}

/** A link tapped in a message while the app runs. */
async function tap(page: Page, link: string): Promise<void> {
  await page.evaluate((link) => {
    ;(window as unknown as { __openUrl: (url: string) => void }).__openUrl(link)
  }, link)
}

const joinButton = (page: Page) => page.getByRole('button', { name: 'Join', exact: true })

test('a link that starts the app fills in its join screen, and joins nothing', async ({
  browser,
}) => {
  const page = await appWithLinks(browser, 'crewbox://join?server=127.0.0.1%3A4299&pin=4242')
  await page.goto('/')

  await expect(page.getByLabel('Crew server')).toHaveValue('127.0.0.1:4299')
  await expect(page.getByLabel('Event PIN')).toHaveValue('4242')
  await expect(page.getByRole('status')).toHaveText(
    'Filled in 127.0.0.1:4299 and the event PIN from the link.'
  )
  await expect(page.getByLabel('Your name')).toBeFocused()

  // A reload is not the link again: the plugin still answers with it, and
  // the page reloads itself to change events.
  await page.reload()
  await expect(page.getByLabel('Crew server')).toHaveValue('')
  await expect(page.getByLabel('Event PIN')).toHaveValue('')
  await expect(page.getByRole('status')).toHaveCount(0)

  // Tapped again while the app runs, it fills in again, and Join is the join.
  await tap(page, 'crewbox://join?server=127.0.0.1%3A4299&pin=4242')
  await expect(page.getByLabel('Event PIN')).toHaveValue('4242')
  await page.getByLabel('Your name').fill(uniqueName('Link Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await joinButton(page).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  // One for the box it is signed in to asks nothing of anyone.
  await tap(page, 'crewbox://join?server=127.0.0.1%3A4299&pin=4242')
  await expect(page.getByRole('dialog', { name: 'Your boxes' })).toHaveCount(0)
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
})

test('a link for another box, tapped while signed in, is that box’s join form a tap away', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const saturday = await startBox(4325, '5454')
  try {
    const page = await appWithLinks(browser)
    await page.goto('/')
    const crew = uniqueName('Link Rota')
    await page.getByLabel('Crew server').fill('127.0.0.1:4299')
    await page.getByLabel('Your name').fill(crew)
    await page.getByLabel('Event PIN').fill('4242')
    await page.getByLabel('Your PIN').fill('1234')
    await joinButton(page).click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()

    await tap(page, `crewbox://join?server=${encodeURIComponent(saturday.address)}&pin=5454`)

    // Offered, not taken: its address where one is typed, and this event open behind.
    const boxes = page.getByRole('dialog', { name: 'Your boxes' })
    await expect(boxes).toBeVisible()
    await expect(boxes.getByLabel('Another box')).toHaveValue(saturday.address)
    await expect(boxes.getByText('From the link. Connect to open it.')).toBeVisible()

    await boxes.getByRole('button', { name: 'Connect' }).click()
    await expect(page.getByLabel('Crew server')).toHaveValue(`http://${saturday.address}`)
    await expect(page.getByLabel('Event PIN')).toHaveValue('5454')
    await page.getByLabel('Your name').fill(crew)
    await page.getByLabel('Your PIN').fill('1234')
    await joinButton(page).click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()

    // Signed in there, with the first box's event still held.
    await page.getByRole('button', { name: 'Open channels' }).first().click()
    await page.getByRole('button', { name: 'Your boxes', exact: true }).click()
    const rows = page.getByRole('dialog', { name: 'Your boxes' }).locator('.boxes-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText(saturday.address)
    await expect(rows.first()).toContainText('Open')
  } finally {
    await saturday.stop()
  }
})

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/129.0.0.0 Mobile Safari/537.36'

test('a phone’s browser offers the app its join form, as each phone opens a link', async ({
  browser,
}) => {
  for (const [userAgent, href] of [
    [IPHONE, 'crewbox://join?server=localhost%3A4299&pin=4242'],
    [
      ANDROID,
      'intent://join?server=localhost%3A4299&pin=4242#Intent;scheme=crewbox;' +
        'package=com.colmhewson.crewbox;' +
        'S.browser_fallback_url=http%3A%2F%2Flocalhost%3A4299%2Fconnect;end',
    ],
  ]) {
    const context = await browser.newContext({
      userAgent,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
    const page = await context.newPage()
    // As the poster's QR opens it in the phone's own browser.
    await page.goto('/?pin=4242')
    const link = page.getByRole('link', { name: 'Open in the Crewbox app' })
    await expect(link).toHaveAttribute('href', href)
    // Under Join, and on the screen without scrolling sideways.
    const join = (await page.getByRole('button', { name: 'Join', exact: true }).boundingBox())!
    const box = (await link.boundingBox())!
    expect(box.y).toBeGreaterThan(join.y + join.height)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await context.close()
  }

  // A computer's browser has no app to open.
  const page = await browser.newPage()
  await page.goto('/?pin=4242')
  await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open in the Crewbox app' })).toHaveCount(0)
  await page.close()
})
