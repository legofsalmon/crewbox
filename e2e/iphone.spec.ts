import { expect } from '@playwright/test'
import { test, uniqueName } from './helpers'

/**
 * The iPhone app's join screen, with a browser standing in for the app as
 * android.spec.ts describes: a page given `window.Capacitor` takes the
 * app's paths.
 *
 * What only the real phone does is refuse plain HTTP to a name, inside the
 * phone, before anything is sent (App Transport Security). A browser does
 * not, so this shows the app saying so before it tries, and an address the
 * phone does allow still getting in.
 */
test('the iPhone app says why a plain-HTTP name will not work, before trying it', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  await context.addInitScript(() => {
    ;(window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {},
    }
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`)
  })
  const asked: string[] = []
  page.on('request', (request) => asked.push(request.url()))

  await page.goto('/?pin=4242')
  // What a poster for a box with a certificate shows: its name, no scheme.
  await page.getByLabel('Crew server').fill('chat.crew.example:4299')
  await page.getByLabel('Your name').fill(uniqueName('iPhone Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()

  await expect(
    page.getByText(
      'An iPhone only connects to a name like chat.crew.example over HTTPS. Type https:// ' +
        'before it if the box has a certificate, or use the box’s IP address, like 192.168.8.1.'
    )
  ).toBeVisible()
  expect(asked.filter((url) => url.includes('crew.example'))).toEqual([])

  // An IP address is one the phone allows.
  await page.getByLabel('Crew server').fill('127.0.0.1:4299')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  await context.close()
})
