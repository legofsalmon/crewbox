import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Browser, type Page } from '@playwright/test'
import { addAct, createSheet, openPatch, test, uniqueName } from './helpers'

/**
 * One phone, more than one box.
 *
 * The app talks to every box from one origin, and kept everything under
 * names taken from the module alone. So a phone that went from one event's
 * box to the next carried the first event's sheets and running order into
 * the second box, where that crew found them. A spare box with a fresh
 * database, put where the event's box was, was sent the lot, and so were the
 * queued messages and show-log entries meant for the box it replaced.
 *
 * These run real boxes of their own beside the suite's: a box is a database,
 * and a second event needs a second one.
 */

interface Box {
  address: string
  dataDir: string
  stop: () => Promise<void>
}

const SERVER_DIR = join(process.cwd(), 'server')

/** A box on its own port and database, as the suite's own is started. */
async function startBox(port: number, pin: string, dataDir?: string): Promise<Box> {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'crewbox-e2e-box-'))
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
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
      CREWBOX_MODULES: 'schedule,patch,lighting,incident,video,network',
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
    dataDir: dir,
    stop: async () => {
      // The whole group: npx, tsx and the node process under them.
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        // Already gone.
      }
      await exited
    },
  }
}

/** What a box's relay is holding: rooms open, and documents kept. */
async function relayOf(box: Box): Promise<{ rooms: number; kept: number }> {
  const health = (await (await fetch(`http://${box.address}/api/health`)).json()) as {
    docs: { rooms: number; kept: number }
  }
  return health.docs
}

/** The Android app, as android.spec.ts stands in for it, on a laptop-sized screen. */
async function appDevice(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    ;(window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {},
    }
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`)
  })
  await page.goto('/')
  return page
}

/** The join screen, filled in and sent: the app's own, with its box field. */
async function joinBox(page: Page, address: string, name: string, pin: string) {
  await page.getByLabel('Crew server').fill(address)
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Event PIN').fill(pin)
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
}

/** A browser at a box's own address: a crew member who has only ever known that one. */
async function browserAt(browser: Browser, box: Box, pin: string): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`http://${box.address}/?pin=${pin}`)
  await page.getByLabel('Your name').fill(uniqueName('Local'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  return page
}

test('the app keeps each event’s sheets and running order to its own box', async ({ browser }) => {
  test.setTimeout(120_000)
  const saturday = await startBox(4310, '4343')
  try {
    const page = await appDevice(browser)
    const crew = uniqueName('Two Box Tech')
    await joinBox(page, '127.0.0.1:4299', crew, '4242')
    const fridaySheet = uniqueName('Friday Stage')
    const fridayAct = uniqueName('Friday Headliner')
    await openPatch(page)
    await createSheet(page, fridaySheet)
    await addAct(page, fridayAct)

    // Signed out, then into the next event's box, as a phone moves on.
    await page.getByRole('button', { name: 'Sign out' }).click()
    await joinBox(page, saturday.address, crew, '4343')
    await openPatch(page)
    await expect(page.locator('main').getByText(fridaySheet)).toHaveCount(0)
    // A sheet of Saturday's own, which puts an act on its running order.
    const saturdaySheet = uniqueName('Saturday Stage')
    await createSheet(page, saturdaySheet)

    // Saturday's own crew has what the phone made there, so the phone has
    // synced with that box, and has none of Friday's: no sheet, no act.
    const local = await browserAt(browser, saturday, '4343')
    await openPatch(local)
    await expect(local.locator('main').getByText(saturdaySheet).first()).toBeVisible()
    await expect(local.locator('main').getByText(fridaySheet)).toHaveCount(0)
    await local.goto(`http://${saturday.address}/m/schedule`)
    await local.getByRole('button', { name: 'Edit' }).click()
    const editor = local.locator('main')
    await expect(editor.getByRole('button', { name: 'Remove Act 1' }).first()).toBeVisible()
    await expect(editor.getByRole('button', { name: `Remove ${fridayAct}` })).toHaveCount(0)

    // Back to Friday's box: the sheet was on this phone the whole time.
    await page.getByRole('button', { name: 'Sign out' }).click()
    await joinBox(page, '127.0.0.1:4299', crew, '4242')
    await openPatch(page)
    await expect(page.locator('main').getByText(fridaySheet).first()).toBeVisible()
    await expect(page.locator('main').getByText(saturdaySheet)).toHaveCount(0)
  } finally {
    await saturday.stop()
    rmSync(saturday.dataDir, { recursive: true, force: true })
  }
})

test('a box that comes back with a new database is sent nothing of the old event’s', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  let box = await startBox(4311, '4444')
  const firstDir = box.dataDir
  try {
    const page = await appDevice(browser)
    const crew = uniqueName('Swap Tech')
    await joinBox(page, box.address, crew, '4444')
    await page.getByPlaceholder(/Message/).fill('Doors in ten')
    await page.getByPlaceholder(/Message/).press('Enter')
    await expect(page.locator('.msg', { hasText: 'Doors in ten' })).not.toHaveClass(/pending/)
    const sheet = uniqueName('Main Stage')
    await openPatch(page)
    await createSheet(page, sheet)

    // The box goes down with a message still to send...
    await box.stop()
    await page.getByRole('button', { name: '#general' }).click()
    await expect(page.locator('.conn-banner')).toBeVisible({ timeout: 15_000 })
    const queued = 'Barrier moved at stage left'
    await page.getByPlaceholder(/Message/).fill(queued)
    await page.getByPlaceholder(/Message/).press('Enter')
    await expect(page.locator('.msg', { hasText: queued })).toHaveClass(/pending/)

    // ...and a spare with a fresh database is put where it was.
    box = await startBox(4311, '4444')
    await page.reload()
    await expect(
      page.getByRole('button', {
        name: 'The box at 127.0.0.1:4311 has changed, and is starting afresh. Open it',
      })
    ).toBeVisible()

    // It was offered nothing of the old event's: no document, and not the
    // message waiting to go.
    await page.waitForTimeout(1500)
    expect(await relayOf(box)).toMatchObject({ rooms: 0, kept: 0 })
    // And nothing was taken off the phone: the chat, the message still to
    // send, and the sheet are all here to read.
    await expect(page.locator('.msg', { hasText: 'Doors in ten' })).toBeVisible()
    await expect(page.locator('.msg', { hasText: queued })).toHaveClass(/pending/)
    await openPatch(page)
    await expect(page.locator('main').getByText(sheet).first()).toBeVisible()

    // Opening the event that is there now asks to join it, as a new event...
    await page.getByRole('button', { name: /has changed.*Open it/ }).click()
    await expect(page.getByLabel('Crew server')).toHaveValue('http://127.0.0.1:4311')
    await joinBox(page, box.address, crew, '4444')
    // ...which starts empty, on this phone as on the box.
    await expect(page.locator('.msg', { hasText: 'Doors in ten' })).toHaveCount(0)
    await expect(page.locator('.msg', { hasText: queued })).toHaveCount(0)
    await openPatch(page)
    await expect(page.locator('main').getByText(sheet)).toHaveCount(0)
  } finally {
    await box.stop()
    rmSync(box.dataDir, { recursive: true, force: true })
    rmSync(firstDir, { recursive: true, force: true })
  }
})
