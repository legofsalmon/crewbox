import { truncateSync, writeFileSync } from 'node:fs'
import { expect, type Browser } from '@playwright/test'
import { test, uniqueName } from './helpers'

/**
 * The Android app, as far as a browser can stand in for it.
 *
 * The app is this web app inside Capacitor's web view, and the page knows it
 * is there because the web view puts `window.Capacitor` on it. A page given
 * the same object takes the same paths, which is how these reach what only
 * the Android app shows. What the native side then does is out of reach
 * here: the camera opening is the web view's to do, and this stops at the
 * page asking for it.
 */
async function androidApp(browser: Browser, colorScheme: 'light' | 'dark' = 'dark') {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    colorScheme,
  })
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
  // The app is not served by the box, so its join screen asks where the box
  // is; the poster's QR fills that in, as it does here.
  await page.goto('/?server=http://localhost:4299&pin=4242')
  await page.getByLabel('Your name').fill(uniqueName('Android Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  return { context, page }
}

test('the Android app offers the camera from the attach button', async ({ browser }) => {
  const { context, page } = await androidApp(browser)

  await page.getByRole('button', { name: 'Attach a file or photo' }).tap()
  const menu = page.getByRole('menu', { name: 'Attach' })
  await expect(menu).toBeVisible()

  // On the screen, and above the composer rather than over it.
  const box = (await menu.boundingBox())!
  const composer = (await page.getByPlaceholder(/Message/).boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(box.y + box.height).toBeLessThanOrEqual(composer.y)

  // "Take a photo" asks the web view for a capture, which is what opens the
  // camera on the phone.
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: 'Take a photo' }).tap()
  const picker = await chooser
  expect(await picker.element().getAttribute('capture')).toBe('environment')
  expect(await picker.element().getAttribute('accept')).toBe('image/*')
  await expect(menu).toBeHidden()

  // And what the camera hands back goes to the channel like any photo.
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 48
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#3a7'
    ctx.fillRect(0, 0, 64, 48)
    return canvas.toDataURL('image/jpeg').split(',')[1]!
  })
  const name = `JPEG_${Date.now()}_1.jpg`
  await picker.setFiles({ name, mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') })
  await expect(page.getByAltText(name)).toBeVisible({ timeout: 15_000 })

  await context.close()
})

test('the Android app keeps the ordinary picker one tap further in', async ({ browser }) => {
  const { context, page } = await androidApp(browser, 'light')

  await page.getByRole('button', { name: 'Attach a file or photo' }).tap()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: 'Choose a photo or file' }).tap()
  const picker = await chooser
  expect(await picker.element().getAttribute('capture')).toBeNull()

  const name = uniqueName('rider') + '.txt'
  await picker.setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Stage left: 2x DI') })
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 })

  await context.close()
})

/**
 * Android's file chooser filters by MIME type, and there is none for .mvr:
 * asked for ".csv,.mvr,text/csv", Capacitor dropped the extension it had no
 * type for and the chooser offered CSVs only. So the app asks for no type
 * at all, and turns away what isn't a rig file once it has been chosen.
 */
test('the Android app can pick an MVR, and is told what else it picked', async ({ browser }) => {
  const { context, page } = await androidApp(browser)
  await page.getByRole('button', { name: 'Open channels' }).first().tap()
  await page.getByRole('button', { name: 'All plots…' }).tap()

  const choose = async () => {
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: /Import CSV \/ MVR/ }).tap()
    return chooser
  }
  let picker = await choose()
  expect(await picker.element().getAttribute('accept')).toBeNull()
  const pdf = Buffer.from('%PDF-1.7')
  await picker.setFiles({ name: 'Rider.pdf', mimeType: 'application/pdf', buffer: pdf })
  await expect(page.getByText('Rider.pdf isn’t a CSV or MVR')).toBeVisible()

  // A phone's memory: a file too big to read is sent to a computer instead,
  // before a byte of it is read or a plot is made for it.
  const big = test.info().outputPath('Festival Rig.mvr')
  writeFileSync(big, '')
  truncateSync(big, 101 * 1024 * 1024)
  picker = await choose()
  await picker.setFiles(big)
  await expect(
    page.getByText(/^Festival Rig\.mvr is 101 MB, too big to read on a phone\./)
  ).toBeVisible()
  await expect(page.locator('main').getByText('Festival Rig', { exact: true })).toHaveCount(0)

  picker = await choose()
  await picker.setFiles('e2e/fixtures/rig.mvr')
  await expect(page.getByText(/Imported 4 fixtures across/)).toBeVisible()
  // A plot's own Import button asks the same way, and answers the same.
  const own = page.getByLabel('Import', { exact: true })
  expect(await own.getAttribute('accept')).toBeNull()
  await own.setInputFiles({ name: 'Rider.pdf', mimeType: 'application/pdf', buffer: pdf })
  await expect(page.getByText('Rider.pdf isn’t a CSV or MVR')).toBeVisible()

  await context.close()
})
