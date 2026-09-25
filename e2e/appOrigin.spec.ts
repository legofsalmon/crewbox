import { expect } from '@playwright/test'
import { test, uniqueName } from './helpers'

/**
 * The apps load this web app from their own package, so everything they send
 * their box comes from another origin. For a DELETE or a PATCH the web view
 * asks the box first, and a browser at the box's own address never does, so
 * the box's answer went untested: it allowed GET, HEAD and POST only, and in
 * both apps deleting your account said to check the connection.
 *
 * Here the app is the page at localhost and its box is 127.0.0.1: the suite's
 * own box, reached from another origin, as the apps reach theirs.
 */
test('the Android app deletes an account on its box, from its own origin', async ({ browser }) => {
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
  // Short enough for the join screen's 24 characters, so the name typed to
  // confirm is the name the box has.
  const name = uniqueName('Leaver')
  await page.goto('/?server=http://127.0.0.1:4299&pin=4242')
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  expect(new URL(page.url()).origin).not.toBe('http://127.0.0.1:4299')

  await page.getByRole('button', { name: 'Delete account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete account' })
  await dialog.getByRole('textbox').fill(name)
  await dialog.getByRole('button', { name: 'Delete account' }).click()
  // Back at the join screen, not stopped at "check the connection".
  await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeVisible()
  await expect(dialog).toHaveCount(0)

  // And gone from the box: the name is free again, whatever the PIN.
  const again = await fetch('http://127.0.0.1:4299/api/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, eventPin: '4242', personalPin: '9876' }),
  })
  expect(again.status).toBe(200)
  expect(((await again.json()) as { created: boolean }).created).toBe(true)
  await context.close()
})
