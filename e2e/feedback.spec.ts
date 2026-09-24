import { expect, type Page } from '@playwright/test'
import { textContrast } from './contrast.ts'
import { newDevice, test } from './helpers.ts'

/**
 * "Send feedback…" and the crash-report setting, from a browser.
 *
 * What goes is only what is on the form. The two ticks start empty, the
 * licence one is offered only to an unlocked admin on a licensed box, and the
 * box keeps the report until it has internet — which in this suite it never
 * does (LETISSIER_API is a port nothing answers on, and a box run from source
 * makes no outbound connections anyway), so "the box has it" is the most any
 * run can see, and all a crew member ever needs to.
 */

const unlock = async (page: Page) => {
  await page.getByRole('button', { name: 'Admin panel' }).click()
  await page.getByLabel('Admin password').fill('e2e-admin-password')
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByRole('heading', { name: 'Crew' })).toBeVisible()
}

test('a crew member sends feedback, with nothing extra ticked', async ({ browser }) => {
  const crew = await newDevice(browser, 'Feedback Crew')
  await crew.getByRole('button', { name: 'Send feedback…' }).click()
  const dialog = crew.getByRole('dialog', { name: 'Send feedback' })
  await expect(dialog).toBeVisible()

  // Not an admin: no licence tick at all. The public tick starts empty.
  await expect(dialog.getByText('Include my licence so you know who I am')).toHaveCount(0)
  await expect(dialog.getByLabel(/OK to post this publicly/)).not.toBeChecked()

  const send = dialog.getByRole('button', { name: 'Send', exact: true })
  await expect(send).toBeDisabled()
  await dialog.getByLabel('Something’s broken').check()
  await dialog.getByLabel('Message').fill('The patch sheet scrolls sideways on a small phone')
  await send.click()
  await expect(dialog).toContainText('the crew box has it')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toHaveCount(0)
})

test('an admin on a licensed box is offered the licence tick', async ({ browser }) => {
  const admin = await newDevice(browser, 'Feedback Admin')
  await unlock(admin)
  await admin.getByRole('button', { name: 'Close admin panel' }).click()
  await admin.getByRole('button', { name: 'Send feedback…' }).click()
  const dialog = admin.getByRole('dialog', { name: 'Send feedback' })
  const tick = dialog.getByLabel('Include my licence so you know who I am')
  await expect(tick).toBeVisible()
  await expect(tick).not.toBeChecked()
  await tick.check()
  await dialog.getByLabel('Message').fill('Worked all weekend')
  await dialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(dialog).toContainText('the crew box has it')
})

test('crash reports start off, and the admin panel says what they hold', async ({ browser }) => {
  const admin = await newDevice(browser, 'Reports Admin')
  await unlock(admin)
  const setting = admin.getByLabel('Send crash reports automatically')
  await expect(setting).toBeVisible()
  await expect(setting).not.toBeChecked()
  await expect(
    admin.getByText(/Never messages, names, files, the event or the licence/)
  ).toBeVisible()
  // A box run from source makes no outbound connections, and says so.
  await expect(admin.getByText(/set to make no outbound connections/)).toBeVisible()
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the feedback form is readable in ${scheme} theme`, async ({ browser }) => {
    // Its own context, as theme.spec.ts does: the theme follows the colour
    // scheme the device reports when the app starts.
    const context = await browser.newContext({ colorScheme: scheme })
    const crew = await context.newPage()
    crew.on('pageerror', (e) => {
      throw new Error(`Page error: ${e.message}`)
    })
    await crew.goto('/?pin=4242')
    await crew.getByLabel('Your name').fill(`Feedback ${scheme}`)
    await crew.getByLabel('Your PIN').fill('1234')
    await crew.getByRole('button', { name: 'Join' }).click()
    await expect(crew.getByPlaceholder(/Message/)).toBeVisible()

    // The link sits in the drawer footer, small; it still has to clear AA.
    expect(await textContrast(crew, '.feedback-link')).toBeGreaterThan(4.5)
    await crew.getByRole('button', { name: 'Send feedback…' }).click()
    await expect(crew.getByRole('dialog', { name: 'Send feedback' })).toBeVisible()
    expect(await textContrast(crew, '.feedback-panel h3')).toBeGreaterThan(4.5)
    expect(await textContrast(crew, '.feedback-panel p')).toBeGreaterThan(4.5)
    expect(await textContrast(crew, '.feedback-tick')).toBeGreaterThan(4.5)
    expect(await textContrast(crew, '.feedback-type')).toBeGreaterThan(4.5)
    await context.close()
  })
}
