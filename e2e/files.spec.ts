import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { test, uniqueName } from './helpers'

/**
 * Files leaving the apps: an export, and a file from the chat, on each phone.
 *
 * As in android.spec.ts, a page given `window.Capacitor` takes the app's
 * paths. Here it also gets stand-ins for the native half: the Android app's
 * FilesPlugin, which records what it was asked to save or share, and the
 * iPhone's share sheet, which can refuse the first share the way WebKit does
 * when the tap that asked for it was more than five seconds ago.
 */

type Call = [kind: 'save' | 'share', file: Record<string, string | undefined>]

async function phoneApp(
  browser: Browser,
  platform: 'android' | 'ios',
  { refuseFirstShare = false } = {}
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  await context.addInitScript(
    ({ platform, refuseFirstShare }) => {
      const calls: unknown[] = []
      ;(window as unknown as { __calls: unknown[] }).__calls = calls
      const plugins: Record<string, unknown> = {}
      if (platform === 'android') {
        plugins.CrewboxFiles = {
          save: async (file: { filename: string }) => {
            calls.push(['save', file])
            return { saved: true, name: file.filename, folder: 'Downloads' }
          },
          share: async (file: unknown) => {
            calls.push(['share', file])
          },
        }
      } else {
        let refuse = refuseFirstShare
        Object.assign(navigator, {
          canShare: () => true,
          share: async (data: { files?: File[] }) => {
            const file = data.files?.[0]
            calls.push(['share', { filename: file?.name, type: file?.type }])
            if (refuse) {
              refuse = false
              throw new DOMException('The request is not allowed', 'NotAllowedError')
            }
          },
        })
      }
      ;(window as unknown as { Capacitor: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => platform,
        Plugins: plugins,
      }
    },
    { platform, refuseFirstShare }
  )
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`)
  })
  await page.goto('/?server=http://localhost:4299&pin=4242')
  await page
    .getByLabel('Your name')
    .fill(uniqueName(platform === 'ios' ? 'iPhone Tech' : 'Android Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  return { context, page }
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __calls: Call[] }).__calls)

async function downloadAuditReport(page: Page) {
  await page.getByRole('button', { name: 'Open channels' }).first().tap()
  await page.getByRole('button', { name: 'Open network audit' }).tap()
  await page.getByRole('button', { name: 'Download HTML report' }).tap()
}

async function openSharedFile(page: Page, platform: 'android' | 'ios', name: string, text: string) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Attach a file or photo' }).tap()
  // Android's attach button opens a menu with a camera in it; the iPhone's
  // opens the picker, which has its own.
  if (platform === 'android') {
    await page.getByRole('menuitem', { name: 'Choose a photo or file' }).tap()
  }
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })
  await page.getByRole('button', { name: new RegExp(name) }).tap()
  return page.getByRole('dialog', { name: `File ${name}` })
}

const REPORT = /crewbox-network-audit-\d{4}-\d{2}-\d{2}\.html/

test('the Android app saves an export to Downloads and offers to send it on', async ({
  browser,
}) => {
  const { context, page } = await phoneApp(browser, 'android')
  await downloadAuditReport(page)

  const offer = page.getByRole('status').filter({ hasText: 'Saved to Downloads' })
  await expect(offer).toContainText(REPORT)
  // What it used to say, to a crew member holding a phone that had saved
  // nothing: that it could not.
  await expect(page.getByText(/cannot save/)).toHaveCount(0)

  // The report itself went to the plugin, whole.
  const [[kind, saved]] = await calls(page)
  expect(kind).toBe('save')
  expect(saved!.filename).toMatch(REPORT)
  expect(saved!.url).toBeUndefined()
  expect(Buffer.from(saved!.data!, 'base64').toString()).toContain('Network audit')

  // On the screen, where a thumb can reach Share.
  const box = (await offer.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(box.y + box.height).toBeLessThanOrEqual(844)

  await offer.getByRole('button', { name: 'Share' }).tap()
  await expect(offer).toBeHidden()
  expect((await calls(page))[1]).toEqual(['share', saved])

  await context.close()
})

test('the Android app saves a file from the chat to Downloads', async ({ browser }) => {
  const { context, page } = await phoneApp(browser, 'android')
  const name = uniqueName('cue list') + '.txt'
  const dialog = await openSharedFile(page, 'android', name, 'GO 1\nGO 2\n')

  await dialog.getByRole('button', { name: 'Download' }).tap()
  await expect(page.getByRole('status').filter({ hasText: 'Saved to Downloads' })).toContainText(
    name
  )

  // The app fetches it from the box itself, by its address, rather than the
  // page passing the whole file across.
  const [[kind, saved]] = await calls(page)
  expect(kind).toBe('save')
  expect(saved).toMatchObject({ filename: name, mime: 'text/plain' })
  expect(saved!.data).toBeUndefined()
  expect(saved!.url).toMatch(
    new RegExp(`^http://localhost:4299/api/files/[^/]+/${encodeURIComponent(name)}$`)
  )
  expect(await (await page.request.get(saved!.url!)).text()).toBe('GO 1\nGO 2\n')

  await context.close()
})

test('the iPhone app keeps a slow export for a second tap', async ({ browser }) => {
  // The share sheet refuses the first share, as WebKit does when building
  // the file took longer than the five seconds a tap lasts.
  const { context, page } = await phoneApp(browser, 'ios', { refuseFirstShare: true })
  await downloadAuditReport(page)

  const offer = page.getByRole('status').filter({ hasText: 'Ready to save or send' })
  await expect(offer).toContainText(REPORT)
  await expect(page.getByText(/cannot save/)).toHaveCount(0)

  await offer.getByRole('button', { name: 'Share' }).tap()
  await expect(offer).toBeHidden()
  const shares = await calls(page)
  expect(shares).toHaveLength(2)
  expect(shares[1]![1]).toEqual(shares[0]![1])
  expect(shares[1]![1].filename).toMatch(REPORT)

  await context.close()
})

test('the iPhone app shares a file from the chat', async ({ browser }) => {
  const { context, page } = await phoneApp(browser, 'ios')
  const name = uniqueName('rider') + '.txt'
  const dialog = await openSharedFile(page, 'ios', name, 'Stage left: 2x DI')

  await dialog.getByRole('button', { name: 'Download' }).tap()
  await expect.poll(() => calls(page)).toEqual([['share', { filename: name, type: 'text/plain' }]])
  // The sheet was the answer; there is nothing left to offer or to regret.
  await expect(page.getByRole('status').filter({ hasText: name })).toHaveCount(0)
  await expect(dialog.getByText(/cannot save|Could not get/)).toHaveCount(0)

  await context.close()
})
