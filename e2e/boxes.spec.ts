import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, type Browser, type Page } from '@playwright/test'
import {
  addAct,
  announce,
  appWithDiscovery,
  cell,
  commitCell,
  createSheet,
  openPatch,
  openSheetByName,
  test,
  uniqueName,
  type FoundService,
} from './helpers'

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
  // Node itself, with tsx as a loader, rather than `npx tsx`: stop() waits
  // for this process to exit, and npx could exit while the box under it was
  // still closing its database and releasing its run marker. A copy of the
  // data taken then found files vanishing under it.
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
      // The whole group, so anything the box started goes with it.
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        // Already gone.
      }
      await exited
    },
  }
}

/** What a box's relay is holding: rooms open, documents kept, and documents saved. */
async function relayOf(box: Box): Promise<{ rooms: number; kept: number; saved: number }> {
  const health = (await (await fetch(`http://${box.address}/api/health`)).json()) as {
    docs: { rooms: number; kept: number; saved: number }
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
    // A browser at its one box has no other to go to.
    await expect(local.getByRole('button', { name: 'Your boxes', exact: true })).toHaveCount(0)
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

/** The Boxes screen, from the menu. */
async function openBoxes(page: Page) {
  await page.getByRole('button', { name: 'Your boxes', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Your boxes' })).toBeVisible()
}

/** A row of the Boxes screen, by the address it shows. */
const boxRow = (page: Page, address: string) =>
  page.getByRole('dialog', { name: 'Your boxes' }).locator('.boxes-row', { hasText: address })

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

    // Opening the event that is there now asks to join it, as a new event,
    // with the way back to the old one beside it...
    await page.getByRole('button', { name: /has changed.*Open it/ }).click()
    await expect(page.getByLabel('Crew server')).toHaveValue('http://127.0.0.1:4311')
    await expect(page.getByRole('button', { name: 'Your other boxes' })).toBeVisible()
    await joinBox(page, box.address, crew, '4444')
    // ...which asks, once, whether to bring the old event's work across...
    const offer = page.getByRole('dialog', { name: 'Bring your work across?' })
    await expect(offer).toContainText('1 shared document')
    await expect(offer).toContainText('1 unsent message')
    await offer.getByRole('button', { name: 'Not now' }).click()
    // ...and without a yes starts empty, on this phone as on the box.
    await expect(page.locator('.msg', { hasText: 'Doors in ten' })).toHaveCount(0)
    await expect(page.locator('.msg', { hasText: queued })).toHaveCount(0)
    await openPatch(page)
    await expect(page.locator('main').getByText(sheet)).toHaveCount(0)
    expect(await relayOf(box)).toMatchObject({ kept: 0 })
    // Not asked again, and the old event's row still offers it.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Patch Sheets' })).toBeVisible()
    await openBoxes(page)
    await expect(offer).toHaveCount(0)
    await expect(
      boxRow(page, '127.0.0.1:4311').getByRole('button', { name: 'Bring its work here' })
    ).toBeVisible()
  } finally {
    await box.stop()
    rmSync(box.dataDir, { recursive: true, force: true })
    rmSync(firstDir, { recursive: true, force: true })
  }
})

/**
 * A sheet whose crew have all gone, on a box that has restarted since.
 *
 * The box held shared documents in memory only, so after a restart a crew
 * member who had never had a sheet was told it had been deleted, until
 * somebody who had it opened it again. It saves them now.
 */
test('a sheet is still there for somebody who opens it after the box restarts', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  let box = await startBox(4321, '5252')
  try {
    const author = await browserAt(browser, box, '5252')
    await openPatch(author)
    const name = uniqueName('Restart Stage')
    await createSheet(author, name)
    await commitCell(author, 'Act 1', '1', 'Input', 'Kick')
    // Another device has the edit, so the box has had it.
    const checker = await browserAt(browser, box, '5252')
    await openPatch(checker)
    await openSheetByName(checker, name)
    await expect(cell(checker, 'Act 1', '1', 'Input')).toHaveValue('Kick')

    // Everybody who has it gone, and the box restarted.
    await author.context().close()
    await checker.context().close()
    await box.stop()
    box = await startBox(4321, '5252', box.dataDir)
    expect(await relayOf(box)).toMatchObject({ rooms: 0 })
    expect((await relayOf(box)).saved).toBeGreaterThanOrEqual(2)

    const late = await browserAt(browser, box, '5252')
    await openPatch(late)
    await openSheetByName(late, name)
    await expect(cell(late, 'Act 1', '1', 'Input')).toHaveValue('Kick')
  } finally {
    await box.stop()
    rmSync(box.dataDir, { recursive: true, force: true })
  }
})

test('the Boxes screen opens each event this phone holds, and forgets one', async ({ browser }) => {
  test.setTimeout(150_000)
  const saturday = await startBox(4312, '4545')
  try {
    const page = await appDevice(browser)
    const crew = uniqueName('Rota Tech')
    await joinBox(page, '127.0.0.1:4299', crew, '4242')
    const fridaySheet = uniqueName('Friday Stage')
    await openPatch(page)
    await createSheet(page, fridaySheet)

    // To the next box by its address, staying signed in to this one.
    await openBoxes(page)
    await page.getByLabel('Another box').fill(saturday.address)
    await page.getByRole('button', { name: 'Connect' }).click()
    await expect(page.getByLabel('Crew server')).toHaveValue(`http://${saturday.address}`)
    await page.getByLabel('Your name').fill(crew)
    await page.getByLabel('Event PIN').fill('4545')
    await page.getByLabel('Your PIN').fill('1234')
    await page.getByRole('button', { name: 'Join' }).click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()
    const saturdaySheet = uniqueName('Saturday Stage')
    await openPatch(page)
    await createSheet(page, saturdaySheet)

    // Both events, the open one first.
    await openBoxes(page)
    const rows = page.getByRole('dialog', { name: 'Your boxes' }).locator('.boxes-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('127.0.0.1:4312')
    await expect(rows.first()).toContainText('Open')
    await expect(rows.nth(1)).toContainText(/127\.0\.0\.1:4299 · Last here today/)

    // One tap back to Friday, with everything as it was, and none of Saturday's.
    await boxRow(page, '127.0.0.1:4299').getByRole('button').first().click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()
    await openPatch(page)
    await expect(page.locator('main').getByText(fridaySheet).first()).toBeVisible()
    await expect(page.locator('main').getByText(saturdaySheet)).toHaveCount(0)

    // And back to Saturday.
    await openBoxes(page)
    await boxRow(page, '127.0.0.1:4312').getByRole('button').first().click()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()
    await openPatch(page)
    await expect(page.locator('main').getByText(saturdaySheet).first()).toBeVisible()

    // Forgetting Friday says what goes first, and then it has gone: every
    // database and setting of Friday's, and none of the device's own.
    await openBoxes(page)
    await boxRow(page, '127.0.0.1:4299')
      .getByRole('button', { name: /^Forget/ })
      .click()
    const confirm = page.getByRole('dialog', { name: /^Forget/ })
    await expect(confirm).toContainText(
      'This device deletes what it keeps for it: 1 document, its running order, its chat and your sign-in.'
    )
    // As tall as what it asks: it once reached down to the foot of the screen.
    expect((await confirm.boundingBox())?.height).toBeLessThan(400)
    await confirm.getByRole('button', { name: 'Forget', exact: true }).click()
    await expect(
      page.getByRole('dialog', { name: 'Your boxes' }).locator('.boxes-row')
    ).toHaveCount(1)
    const left = await page.evaluate(async () => ({
      databases: (await indexedDB.databases()).map((db) => db.name ?? ''),
      keys: Object.keys(localStorage),
    }))
    expect(
      left.databases.filter((name) => name === 'crewbox' || name.startsWith('crewbox-'))
    ).toEqual([])
    expect(left.databases.some((name) => name.startsWith('crewbox@'))).toBe(true)
    expect(left.keys.filter((key) => key.startsWith('crewbox:')).sort()).toEqual(
      ['crewbox:boxes', 'crewbox:event', 'crewbox:server-url'].sort()
    )

    // Saturday carries on as it was.
    await page
      .getByRole('dialog', { name: 'Your boxes' })
      .getByRole('button', { name: 'Close' })
      .click()
    await expect(page.locator('main').getByText(saturdaySheet).first()).toBeVisible()
  } finally {
    await saturday.stop()
    rmSync(saturday.dataDir, { recursive: true, force: true })
  }
})

test('the app is told where its box has gone, and carries on there', async ({ browser }) => {
  test.setTimeout(120_000)
  let box = await startBox(4313, '4646')
  try {
    const page = await appDevice(browser)
    await joinBox(page, box.address, uniqueName('Moved Tech'), '4646')
    const sheet = uniqueName('Moved Stage')
    await openPatch(page)
    await createSheet(page, sheet)

    // The same box, database and all, comes back at another address.
    await box.stop()
    box = await startBox(4314, '4646', box.dataDir)
    await page.reload()
    await expect(page.locator('.conn-banner')).toBeVisible({ timeout: 15_000 })

    await openBoxes(page)
    const field = page.getByLabel('Another box')
    await field.fill('127.0.0.1:4313')
    await page.getByRole('button', { name: 'Connect' }).click()
    await expect(page.getByText('Nothing answered at 127.0.0.1:4313.')).toBeVisible()
    await field.fill('127.0.0.1:4314')
    await page.getByRole('button', { name: 'Connect' }).click()

    // Found, as the same event: everything this phone had, now online there.
    await expect(page.locator('.conn-banner')).toBeHidden({ timeout: 15_000 })
    await openPatch(page)
    await expect(page.locator('main').getByText(sheet).first()).toBeVisible()
    await openBoxes(page)
    const rows = page.getByRole('dialog', { name: 'Your boxes' }).locator('.boxes-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('127.0.0.1:4314')
  } finally {
    await box.stop()
    rmSync(box.dataDir, { recursive: true, force: true })
  }
})

/**
 * A copy of a stopped box's data, as a backup restored onto a spare is. Or
 * one that has the event's ID and not its key, as anything copying the
 * event, or a spare restored from a backup older than the key, would.
 */
function copyOfBox(dataDir: string, { withoutKey = false } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'crewbox-e2e-copy-'))
  cpSync(dataDir, dir, { recursive: true })
  if (withoutKey) {
    const db = new DatabaseSync(join(dir, 'crewbox.db'))
    db.prepare("DELETE FROM settings WHERE key = 'identityKey'").run()
    db.close()
  }
  return dir
}

/** Each event the app holds: where it has it, and the key it kept for it. */
const heldEvents = (page: Page) =>
  page.evaluate(() =>
    (
      JSON.parse(localStorage.getItem('crewbox:boxes') ?? '[]') as Array<{
        id: string
        origin?: string
        key?: string
      }>
    ).map(({ id, origin, key }) => ({ id, origin, key }))
  )

/** The event a box says it runs, and its key. */
async function eventOf(box: Box): Promise<{ id: string; key: string }> {
  const config = (await (await fetch(`http://${box.address}/api/config`)).json()) as {
    eventId: string
    eventKey: string
  }
  return { id: config.eventId, key: config.eventKey }
}

test('a typed address claiming this phone’s event is followed only when its box proves it', async ({
  browser,
}) => {
  test.setTimeout(150_000)
  let box = await startBox(4316, '4747')
  const dirs = [box.dataDir]
  let copy: Box | undefined
  try {
    const page = await appDevice(browser)
    await joinBox(page, box.address, uniqueName('Proven Tech'), '4747')
    // The key the event's box gave it, kept with the event.
    const event = await eventOf(box)
    expect(await heldEvents(page)).toEqual([{ ...event, origin: 'http://127.0.0.1:4316' }])
    const sheet = uniqueName('Proven Stage')
    await openPatch(page)
    await createSheet(page, sheet)

    // The box goes, and something with the event's ID and not its key is
    // put at another address.
    await box.stop()
    const keyless = copyOfBox(box.dataDir, { withoutKey: true })
    dirs.push(keyless)
    copy = await startBox(4317, '4747', keyless)
    await page.reload()
    await expect(page.locator('.conn-banner')).toBeVisible({ timeout: 15_000 })
    await openBoxes(page)
    await page.getByLabel('Another box').fill(copy.address)
    await page.getByRole('button', { name: 'Connect' }).click()
    await expect(
      page.getByText(
        'The box at 127.0.0.1:4317 says it is running an event, but it can’t show that it ' +
          'is that event’s box, so nothing has gone to it.'
      )
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open it anyway' })).toBeVisible()
    // Nothing went to it, and the phone still knows its event where it was.
    await page.waitForTimeout(1000)
    expect(await relayOf(copy)).toMatchObject({ rooms: 0 })
    await expect(boxRow(page, '127.0.0.1:4316')).toBeVisible()
    expect(await heldEvents(page)).toEqual([{ ...event, origin: 'http://127.0.0.1:4316' }])
    await copy.stop()

    // The event's own box, restored with its key at another address, proves
    // it and is followed there, with everything this phone had.
    const restored = copyOfBox(box.dataDir)
    dirs.push(restored)
    box = await startBox(4318, '4747', restored)
    await page.getByLabel('Another box').fill(box.address)
    await page.getByRole('button', { name: 'Connect' }).click()
    await expect(page.locator('.conn-banner')).toBeHidden({ timeout: 15_000 })
    await openPatch(page)
    await expect(page.locator('main').getByText(sheet).first()).toBeVisible()
    // Where it is now, with the key it always had.
    expect(await heldEvents(page)).toEqual([{ ...event, origin: 'http://127.0.0.1:4318' }])
  } finally {
    await box.stop()
    await copy?.stop()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
})

/** A box as the phone's search would find it: announcing `event` at its own port. */
const announced = (box: Box, event: string, name: string): FoundService => ({
  name,
  addresses: ['127.0.0.1'],
  port: Number(box.address.split(':')[1]),
  txt: { txtvers: '1', id: event, name, setup: '1' },
})

test('the app finds its box at a new address on the Wi-Fi, and goes on there once it proves it', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  let box = await startBox(4322, '5353')
  const dirs = [box.dataDir]
  let copy: Box | undefined
  try {
    const page = await appWithDiscovery(browser, 'android', [])
    await page.goto('/')
    await joinBox(page, box.address, uniqueName('Found Tech'), '5353')
    const event = await eventOf(box)
    expect(await heldEvents(page)).toEqual([{ ...event, origin: 'http://127.0.0.1:4322' }])
    // Something in hand that a reload would lose.
    const draft = 'Half a note about the stage left barrier'
    await page.getByPlaceholder(/Message/).fill(draft)

    // The box goes, and something with the event's ID and not its key
    // announces it at another address.
    await box.stop()
    const keyless = copyOfBox(box.dataDir, { withoutKey: true })
    dirs.push(keyless)
    copy = await startBox(4323, '5353', keyless)
    await announce(page, [announced(copy, event.id, 'Harbour Fest')])
    await expect(page.locator('.conn-banner')).toBeVisible({ timeout: 15_000 })

    // Once the box has been gone a while, the app looks for it, and asks
    // what it finds to prove it.
    const asked = await page.waitForResponse(
      (res) => res.url().startsWith(`http://${copy!.address}/api/identity?nonce=`),
      { timeout: 60_000 }
    )
    expect(asked.status()).toBe(200)
    // It can't: nothing else went to it, and the phone stays where it was.
    await page.waitForTimeout(1500)
    expect(await relayOf(copy)).toMatchObject({ rooms: 0 })
    expect(await heldEvents(page)).toEqual([{ ...event, origin: 'http://127.0.0.1:4322' }])
    await expect(page.locator('.conn-banner')).toBeVisible()
    await copy.stop()

    // The event's own box, restored with its key, announces it at a third
    // address: proven, and gone on with, in place.
    const restored = copyOfBox(box.dataDir)
    dirs.push(restored)
    box = await startBox(4324, '5353', restored)
    await announce(page, [announced(box, event.id, 'Harbour Fest')])
    await expect(
      page.getByText(
        'Your box is at a new address, 127.0.0.1:4324. This phone found it and carried on there.'
      )
    ).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.conn-banner')).toBeHidden({ timeout: 15_000 })
    expect(await heldEvents(page)).toEqual([{ ...event, origin: 'http://127.0.0.1:4324' }])
    // No reload: what was being typed is still there.
    await expect(page.getByPlaceholder(/Message/)).toHaveValue(draft)
    // And the documents are with the box there, once it has let the phone in.
    await expect
      .poll(async () => (await relayOf(box)).rooms, { timeout: 15_000 })
      .toBeGreaterThan(0)
  } finally {
    await box.stop()
    await copy?.stop()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
})

test('a box at this address saying it runs an event held elsewhere is opened only once it proves it', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const friday = await startBox(4319, '4848')
  let saturday = await startBox(4320, '4949')
  const dirs = [friday.dataDir, saturday.dataDir]
  try {
    const page = await appDevice(browser)
    const crew = uniqueName('Held Tech')
    await joinBox(page, friday.address, crew, '4848')
    // On to Saturday's box, holding Friday's event at its address.
    await openBoxes(page)
    await page.getByLabel('Another box').fill(saturday.address)
    await page.getByRole('button', { name: 'Connect' }).click()
    await joinBox(page, saturday.address, crew, '4949')
    await friday.stop()

    // Saturday's box goes, and something with Friday's ID and not its key
    // takes Saturday's address.
    await saturday.stop()
    const keyless = copyOfBox(friday.dataDir, { withoutKey: true })
    dirs.push(keyless)
    saturday = await startBox(4320, '4949', keyless)
    await page.reload()
    const refused = page.locator('.conn-banner', {
      hasText:
        'The box at 127.0.0.1:4320 says it is running an event, but it can’t show that it is ' +
        'that event’s box, so nothing has gone to it.',
    })
    await expect(refused).toBeVisible({ timeout: 15_000 })
    // Nothing to open: the way on is its address, typed.
    await expect(refused).toContainText('Your boxes')
    await expect(refused).not.toContainText('Open it')
    await page.waitForTimeout(1000)
    expect(await relayOf(saturday)).toMatchObject({ rooms: 0 })
    await refused.click()
    await expect(page.getByRole('dialog', { name: 'Your boxes' })).toBeVisible()
    await expect(boxRow(page, '127.0.0.1:4319')).toBeVisible()
    await saturday.stop()

    // Friday's own box, restored with its key at that address, proves it,
    // and is the event this phone had, not a new one.
    const restored = copyOfBox(friday.dataDir)
    dirs.push(restored)
    saturday = await startBox(4320, '4949', restored)
    await page.reload()
    await page
      .getByRole('button', {
        name:
          'The box at 127.0.0.1:4320 is running the event this phone knew at 127.0.0.1:4319. ' +
          'Open it',
      })
      .click({ timeout: 15_000 })
    // Friday, where its box is now, signed in as before.
    await expect(page.locator('.conn-banner')).toBeHidden({ timeout: 15_000 })
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()
    const fridayEvent = await eventOf(saturday)
    expect(await heldEvents(page)).toContainEqual({
      ...fridayEvent,
      origin: 'http://127.0.0.1:4320',
    })
  } finally {
    await friday.stop()
    await saturday.stop()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
})

const openLog = async (page: Page) => {
  await page
    .getByRole('button', { name: /Show log/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'Show log' })).toBeVisible()
}

test('the old event’s work comes across to the box that took its place', async ({ browser }) => {
  test.setTimeout(150_000)
  let box = await startBox(4315, '4646')
  const firstDir = box.dataDir
  try {
    const page = await appDevice(browser)
    const crew = uniqueName('Move Tech')
    await joinBox(page, box.address, crew, '4646')
    // A channel of the old box's own, which the box taking over will not have.
    await page.getByRole('button', { name: 'New channel' }).click()
    await page.getByPlaceholder('channel-name').fill('rigging')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: '#rigging' })).toBeVisible()
    // A sheet, and an act on the running order.
    const sheet = uniqueName('Main Stage')
    await openPatch(page)
    await createSheet(page, sheet)

    // The box goes down with work still to send: a message each to #general
    // and #rigging, and a show-log entry.
    await box.stop()
    await page.getByRole('button', { name: '#general' }).click()
    await expect(page.locator('.conn-banner')).toBeVisible({ timeout: 15_000 })
    const toGeneral = 'Barrier moved at stage left'
    await page.getByPlaceholder(/Message/).fill(toGeneral)
    await page.getByPlaceholder(/Message/).press('Enter')
    await page.getByRole('button', { name: '#rigging' }).click()
    const toRigging = 'Truss at trim height'
    await page.getByPlaceholder(/Message/).fill(toRigging)
    await page.getByPlaceholder(/Message/).press('Enter')
    await expect(page.locator('.msg', { hasText: toRigging })).toHaveClass(/pending/)
    await openLog(page)
    await page.getByRole('button', { name: 'Log an entry' }).click()
    const entry = 'Wind reading over limit'
    await page.getByLabel('What happened').fill(entry)
    await page.getByRole('button', { name: 'Log it' }).click()
    // And one written two days ago, which no box would file now.
    const queue = 'crewbox:incident-outbox'
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key) ?? '', queue))
      .toContain(entry)
    await page.evaluate((key) => {
      const queued: unknown[] = JSON.parse(localStorage.getItem(key) ?? '[]')
      queued.push({
        clientMsgId: 'written-two-days-ago',
        kind: 'note',
        severity: 'note',
        body: 'Generator refuelled',
        at: Date.now() - 2 * 24 * 60 * 60_000,
        stage: '',
        actId: '',
        actName: '',
      })
      localStorage.setItem(key, JSON.stringify(queued))
    }, queue)

    // A spare with a fresh database goes where it was, and the phone joins it.
    box = await startBox(4315, '4646')
    await page.reload()
    await page.getByRole('button', { name: /has changed.*Open it/ }).click()
    await joinBox(page, box.address, crew, '4646')

    const offer = page.getByRole('dialog', { name: 'Bring your work across?' })
    for (const item of [
      '1 shared document',
      'the running order',
      '2 unsent messages',
      '2 unsent show-log entries',
    ]) {
      await expect(offer.getByRole('listitem').filter({ hasText: item })).toHaveCount(1)
    }
    await offer.getByRole('button', { name: 'Move it here' }).click()
    const done = page.getByRole('dialog', { name: 'Brought across' })
    await expect(done).toContainText(
      'Brought here: 1 document, the running order, 1 message and 1 show-log entry.'
    )
    await expect(done).toContainText('1 message stayed behind: its channel is not on this box yet.')
    await expect(done).toContainText(
      '1 show-log entry stayed behind: a box only files entries written in the last day.'
    )
    await done.getByRole('button', { name: 'Done' }).click()
    await expect(done).toBeHidden()

    // On the box now, for anybody who joins it: the message in #general, the
    // sheet, the act, and the entry in the log.
    const other = await browserAt(browser, box, '4646')
    await expect(other.locator('.msg', { hasText: toGeneral })).toBeVisible()
    await expect(page.locator('.msg', { hasText: toGeneral })).not.toHaveClass(/pending/)
    await openPatch(other)
    await expect(other.locator('main').getByText(sheet).first()).toBeVisible()
    await other.goto(`http://${box.address}/m/schedule`)
    await other.getByRole('button', { name: 'Edit' }).click()
    await expect(other.getByRole('button', { name: 'Remove Act 1' })).toHaveCount(1)
    await openLog(other)
    await expect(other.getByText(entry)).toBeVisible()
    await expect(other.getByText('Generator refuelled')).toHaveCount(0)

    // The phone keeps no second copy of what came across, and is not asked
    // again. The message whose channel is not here yet stays with the old
    // event, whose row offers it again for when an admin has made #rigging.
    const databases = await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name ?? '')
    )
    expect(databases.filter((name) => name.startsWith('crewbox-patch-sheet-'))).toEqual([])
    expect(databases).not.toContain('crewbox-timetable-event')
    expect(databases.some((name) => /^crewbox@\w+-patch-sheet-/.test(name))).toBe(true)
    await page.reload()
    await expect(page.getByPlaceholder(/Message/)).toBeVisible()
    await openBoxes(page)
    await expect(offer).toHaveCount(0)
    const old = boxRow(page, 'Last here')
    await expect(old).toContainText('2 unsent')
    await expect(old.getByRole('button', { name: 'Bring its work here' })).toBeVisible()
  } finally {
    await box.stop()
    rmSync(box.dataDir, { recursive: true, force: true })
    rmSync(firstDir, { recursive: true, force: true })
  }
})
