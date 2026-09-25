import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { textContrast } from './contrast'
import {
  keepRecordsInTheApp,
  keepSignInsInTheApp,
  newDevice,
  recordsOf,
  test,
  uniqueName,
} from './helpers'

/**
 * Work typed with no signal, on a phone that lets it down (web/src/lib/unsent.ts).
 *
 * offline.spec.ts is the promise when the phone's storage keeps its side of
 * it. These are the times it doesn't: storage that refuses the write, where
 * the screen has to say that closing the app loses what was typed, and in
 * the apps storage wiped from under the page, where the app has to have
 * kept it anyway.
 */

const NOT_SAVED = 'Not saved on this phone. Keep crewbox open until it sends.'

/** The devices this spec opens itself, closed after each test as helpers.ts closes its own. */
const contexts: BrowserContext[] = []
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => {})))
})

async function newPage(context: BrowserContext): Promise<Page> {
  contexts.push(context)
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`)
  })
  await page.goto('/')
  return page
}

/** A browser joined as newDevice joins one, with `init` run in each page before the app. */
async function deviceWith(browser: Browser, init: () => void, name: string): Promise<Page> {
  const context = await browser.newContext()
  await context.addInitScript(init)
  const page = await newPage(context)
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Event PIN').fill('4242')
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  return page
}

/** The Android app, as boxes.spec.ts stands in for it, keeping its sign-ins and its files. */
async function appDevice(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    ;(window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {},
    }
  })
  await context.addInitScript(keepSignInsInTheApp)
  await context.addInitScript(keepRecordsInTheApp)
  const page = await newPage(context)
  await page.getByLabel('Crew server').fill('127.0.0.1:4299')
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Event PIN').fill('4242')
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  return page
}

/** IndexedDB refusing the chat outbox's writes, as a phone out of space does. */
function refuseChatOutbox(): void {
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args) {
    if (this.name === 'outbox') {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    }
    return put.apply(this, args)
  }
}

/** localStorage refusing the show log's queue, as a phone out of space does. */
function refuseShowLogQueue(): void {
  const setItem = Storage.prototype.setItem
  Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
    if (key.includes('incident-outbox')) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    }
    setItem.call(this, key, value)
  }
}

/**
 * Cut a page off from its box, as offline.spec.ts does: `setOffline` leaves
 * an established WebSocket alive, so the socket is refused, and the way back
 * is a flag the handler reads.
 */
async function cutOff(page: Page) {
  let blocked = true
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (blocked) ws.close()
    else ws.connectToServer()
  })
  await page.reload()
  await expect(page.locator('.conn-banner')).toBeVisible({ timeout: 15_000 })
  /** Signal again, taken up the moment the phone notices, with no reload. */
  return async () => {
    blocked = false
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(page.locator('.conn-banner')).toBeHidden({ timeout: 30_000 })
  }
}

const openLog = async (page: Page) => {
  await page
    .getByRole('button', { name: /Show log/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'Show log' })).toBeVisible()
}

async function logEntry(page: Page, body: string) {
  await page.getByRole('button', { name: 'Log an entry' }).click()
  await page.getByLabel('What happened').fill(body)
  await page.getByRole('button', { name: 'Log it' }).click()
}

test('a message this phone couldn’t keep says so, and still reaches the crew', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const alex = await deviceWith(browser, refuseChatOutbox, uniqueName('Alex'))
  const sam = await newDevice(browser, uniqueName('Sam'))
  const back = await cutOff(alex)

  const body = `doors in ten ${Date.now().toString(36)}`
  await alex.getByPlaceholder(/Message/).fill(body)
  await alex.getByPlaceholder(/Message/).press('Enter')
  const mine = alex.locator('.msg', { hasText: body })
  await expect(mine).toHaveClass(/pending/)
  await expect(mine.getByRole('status')).toHaveText(NOT_SAVED)

  // It is what somebody has to read before they close the app, outdoors or
  // in a dark tent.
  for (const scheme of ['light', 'dark'] as const) {
    await alex.emulateMedia({ colorScheme: scheme })
    await expect(alex.locator('html')).toHaveAttribute('data-theme', scheme)
    expect(await textContrast(alex, '.msg.unsaved .msg-unsaved')).toBeGreaterThanOrEqual(4.5)
  }

  // Sent from what the page holds, once the box is back, with no reload.
  await back()
  await expect(sam.locator('.msg', { hasText: body })).toBeVisible({ timeout: 30_000 })
  await expect(mine).not.toHaveClass(/pending/)
  await expect(alex.getByText(NOT_SAVED)).toHaveCount(0)
  await expect(sam.locator('.msg', { hasText: body })).toHaveCount(1)
})

test('a show-log entry this phone couldn’t keep says so, and still reaches the log', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const sm = await deviceWith(browser, refuseShowLogQueue, uniqueName('Log SM'))
  const lx = await newDevice(browser, uniqueName('Log LX'))
  const back = await cutOff(sm)

  await openLog(sm)
  const body = `Barrier moved at stage left ${Date.now().toString(36)}`
  await logEntry(sm, body)
  await expect(sm.getByRole('status').filter({ hasText: 'waiting for the box' })).toHaveText(
    '1 entry is waiting for the box. It isn’t saved on this phone. Keep crewbox open until it sends.'
  )

  await back()
  await openLog(lx)
  await expect(lx.getByText(body)).toBeVisible({ timeout: 30_000 })
  await expect(sm.getByText('waiting for the box')).toHaveCount(0)
})

test('the apps keep unsent work through a wipe of the page’s storage, and send it after the next start', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const phone = await appDevice(browser, uniqueName('App Crew'))
  const sam = await newDevice(browser, uniqueName('Sam'))
  const back = await cutOff(phone)

  const message = `radio check ${Date.now().toString(36)}`
  await phone.getByPlaceholder(/Message/).fill(message)
  await phone.getByPlaceholder(/Message/).press('Enter')
  await expect(phone.locator('.msg', { hasText: message })).toHaveClass(/pending/)
  // Kept, so there is nothing to say.
  await expect(phone.getByText(NOT_SAVED)).toHaveCount(0)

  await openLog(phone)
  const entry = `Generator swapped at FOH ${Date.now().toString(36)}`
  await logEntry(phone, entry)
  await expect(phone.getByRole('status').filter({ hasText: 'waiting for the box' })).toHaveText(
    '1 entry is waiting for the box. They’re held on this phone and go out as soon as it’s back.'
  )

  // The app's files have both, beside the event's record.
  const files = async () => JSON.stringify(await recordsOf(phone))
  await expect.poll(files).toContain(message)
  await expect.poll(files).toContain(entry)
  const folders = Object.values(await recordsOf(phone))
  expect(folders).toHaveLength(1)
  expect(Object.keys(folders[0]!).sort()).toEqual(['event', 'incident-outbox', 'outbox'])

  // The wipe: every IndexedDB database and all of localStorage, from under
  // the open page, as WebKit's tracking prevention takes it on an iPhone.
  const cdp = await phone.context().newCDPSession(phone)
  await cdp.send('Storage.clearDataForOrigin', {
    origin: new URL(phone.url()).origin,
    storageTypes: 'indexeddb,local_storage',
  })
  expect(await phone.evaluate(() => localStorage.length)).toBe(0)
  expect(await phone.evaluate(async () => (await indexedDB.databases()).length)).toBe(0)

  // The next start, still with no signal: signed in and trying its box, from
  // the app's copy, with no chat cache to show and nothing of the work in
  // the page's storage.
  await phone.reload()
  await expect(phone.getByRole('heading', { name: /reach the crew server/ })).toBeVisible({
    timeout: 15_000,
  })
  await expect(phone.getByText('Trying 127.0.0.1:4299')).toBeVisible()
  await expect(phone.getByLabel('Your PIN')).toHaveCount(0)
  expect(await phone.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(entry)

  await back()
  await expect(phone.getByRole('heading', { name: /reach the crew server/ })).toBeHidden({
    timeout: 30_000,
  })
  await expect(sam.locator('.msg', { hasText: message })).toBeVisible({ timeout: 30_000 })
  await expect(sam.locator('.msg', { hasText: message })).toHaveCount(1)
  await openLog(sam)
  await expect(sam.getByText(entry)).toBeVisible({ timeout: 30_000 })

  // And the app lets go of both once the box has them.
  await expect.poll(files).not.toContain(message)
  await expect.poll(files).not.toContain(entry)
})
