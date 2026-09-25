import { expect, type Page } from '@playwright/test'
import { keepSignInsInTheApp, keychainCalls, keychainOf, test, uniqueName } from './helpers'

/**
 * In the apps, a sign-in is the app's, not the web view's (web/src/lib/sessions.ts).
 *
 * The web view's storage is what goes with a backup to a new phone, which
 * then arrived signed in as somebody else's old session. The token now lives
 * in the phone's Keychain or Keystore, stood in for here, and the page keeps
 * only its name. The Android app's alerts service is told that name, so it
 * finds the token again when Android restarts it.
 */

/** The Android app, with its keeping of sign-ins and its alerts service stood in for. */
async function androidApp(browser: import('@playwright/test').Browser): Promise<Page> {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    const started: unknown[] = []
    ;(window as unknown as { __alerts: unknown[] }).__alerts = started
    ;(window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        CrewboxAlerts: {
          start: async (options: unknown) => {
            started.push(options)
          },
          stop: async () => {},
        },
      },
    }
  })
  await context.addInitScript(keepSignInsInTheApp)
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`)
  })
  return page
}

const HELD = '(kept by the app)'

const pageToken = (page: Page) => page.evaluate(() => localStorage.getItem('crewbox:token'))

/** Whether the box takes a token as a sign-in. */
const signsIn = async (page: Page, token: string) =>
  (
    await page.request.get('http://127.0.0.1:4299/api/me', {
      headers: { authorization: `Bearer ${token}` },
    })
  ).ok()

async function join(page: Page, name: string) {
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
}

test('the Android app keeps its sign-in itself, and the page only its name', async ({
  browser,
}) => {
  const page = await androidApp(browser)
  const name = uniqueName('Keeper')
  await page.goto('/?server=http://127.0.0.1:4299&pin=4242')
  await join(page, name)

  // A box's token, with the app; the page has its name and nothing more.
  const kept = await keychainOf(page)
  expect(Object.keys(kept)).toEqual(['crewbox:token'])
  expect(kept['crewbox:token']).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(await pageToken(page)).toBe(HELD)
  const token = kept['crewbox:token']
  // The alerts service gets the token, and the name to find it by again.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __alerts: unknown[] }).__alerts))
    .toContainEqual(expect.objectContaining({ token, session: 'crewbox:token' }))

  // The next start reads it from the app, and is signed in.
  await page.reload()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  expect(await keychainCalls(page)).toEqual(['load'])

  // A page from before this kept the token itself: it moves across, its box
  // renews it, and the crew member stays signed in. The old one, which the
  // page's storage had and so any backup of it, signs nothing in from then.
  await page.evaluate((token) => {
    sessionStorage.removeItem('__keychain')
    localStorage.setItem('crewbox:token', token)
  }, token)
  await page.reload()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  await expect.poll(async () => (await keychainOf(page))['crewbox:token']).not.toBe(token)
  const renewed = (await keychainOf(page))['crewbox:token']
  expect(renewed).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(await pageToken(page)).toBe(HELD)
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __alerts: unknown[] }).__alerts))
    .toContainEqual(expect.objectContaining({ token: renewed, session: 'crewbox:token' }))
  await expect.poll(() => signsIn(page, token)).toBe(false)
  expect(await signsIn(page, renewed)).toBe(true)
  expect(await page.evaluate(() => localStorage.getItem('crewbox:carried-sign-ins'))).toBeNull()
  // And the next start has nothing to renew.
  await page.reload()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  expect(await keychainOf(page)).toEqual({ 'crewbox:token': renewed })

  // Signing out forgets it in both.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeVisible()
  expect(await keychainOf(page)).toEqual({})
  expect(await pageToken(page)).toBeNull()
})

test('a phone given another’s storage, or its own cleared, starts signed out', async ({
  browser,
}) => {
  const page = await androidApp(browser)
  await page.goto('/?server=http://127.0.0.1:4299&pin=4242')
  await join(page, uniqueName('Restored'))
  const { 'crewbox:token': token } = await keychainOf(page)

  // A new phone set up from the old one's backup: the page's storage came,
  // and the app's never does.
  await page.evaluate(() => sessionStorage.removeItem('__keychain'))
  await page.reload()
  await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeVisible()
  expect(await pageToken(page)).toBeNull()

  // The page's storage cleared under a sign-in the app kept (an iPhone's
  // Keychain outlives the app): the app's goes too, rather than signing a
  // fresh start in.
  await page.evaluate((token) => {
    sessionStorage.setItem('__keychain', JSON.stringify({ 'crewbox:token': token }))
    localStorage.removeItem('crewbox:token')
  }, token)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeVisible()
  expect(await keychainOf(page)).toEqual({})
})

test('a copy of a sign-in from before this, on another phone, signs nothing in there', async ({
  browser,
}) => {
  // A phone whose page kept its token itself, as every one did before this.
  const phone = await androidApp(browser)
  await phone.goto('/?server=http://127.0.0.1:4299&pin=4242')
  const name = uniqueName('Backed Up')
  await join(phone, name)
  const { 'crewbox:token': token } = await keychainOf(phone)
  await phone.evaluate((token) => {
    sessionStorage.removeItem('__keychain')
    localStorage.setItem('crewbox:token', token)
  }, token)
  // A backup of it, as Android's and iCloud's took the page's storage.
  const backup = await phone.evaluate(() => JSON.stringify(localStorage))

  // The phone updates: the app moves the token across and its box renews it.
  await phone.reload()
  await expect(phone.getByPlaceholder(/Message/)).toBeVisible()
  await expect.poll(async () => (await keychainOf(phone))['crewbox:token']).not.toBe(token)

  // Another phone set up from the backup: the page's storage came, holding
  // the old token, which its app moves across just the same.
  const copy = await androidApp(browser)
  await copy.goto('/?server=http://127.0.0.1:4299')
  await copy.evaluate((backup) => {
    localStorage.clear()
    for (const [key, value] of Object.entries(JSON.parse(backup) as Record<string, string>)) {
      localStorage.setItem(key, value)
    }
  }, backup)
  await copy.reload()
  // Its box has renewed that one for the first phone, so this one is signed
  // out, and keeps no copy of it.
  await expect(copy.getByRole('button', { name: 'Join', exact: true })).toBeVisible()
  expect(await keychainOf(copy)).toEqual({})
  expect(await copy.evaluate(() => localStorage.getItem('crewbox:token'))).toBeNull()

  // The first phone is still signed in: what it sends, the box takes.
  const message = `Still here ${name}`
  await phone.getByPlaceholder(/Message/).fill(message)
  await phone.getByPlaceholder(/Message/).press('Enter')
  const sent = phone.locator('.msg', { hasText: message })
  await expect(sent).toBeVisible()
  await expect(sent).not.toHaveClass(/pending/)
  expect(await signsIn(phone, token)).toBe(false)
})
