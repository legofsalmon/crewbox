import { expect, type Browser, type Page } from '@playwright/test'
import { textContrast } from './contrast.ts'
import { newDevice, test, uniqueName } from './helpers'

/**
 * Cue lights and the panic button through a real box and real pages
 * (docs/CUES.md). What only a phone can show (the buzz in a pocket, the
 * alarm through silent) is on the phone-test list there.
 */

async function device(browser: Browser, name: string, scheme?: 'light' | 'dark'): Promise<Page> {
  if (!scheme) return newDevice(browser, name)
  const context = await browser.newContext({ colorScheme: scheme })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  return page
}

for (const scheme of ['dark', 'light'] as const) {
  test(`a cue goes standby, standing by, GO, readable in the ${scheme} theme`, async ({
    browser,
  }) => {
    const joName = uniqueName('Jo')
    const jo = await device(browser, joName, scheme)
    const sam = await device(browser, uniqueName('Sam'), scheme)
    // The box is shared with every other test, and the pane shows everyone's
    // cues, so this one is found by its own label.
    const label = uniqueName('Pyro')

    await sam.getByRole('button', { name: /^Cue lights/ }).click()
    await expect(sam.getByRole('heading', { name: 'Cue lights' })).toBeVisible()
    const form = sam.getByRole('form', { name: 'Call a standby' })
    await form.getByLabel('Who').selectOption({ label: joName })
    await form.getByLabel('Cue').fill(label)
    await form.getByRole('button', { name: 'Call standby' }).click()
    const mine = sam.locator('main li', { hasText: label })
    await expect(mine).toContainText(`Waiting for ${joName}`)

    // Jo's whole screen, wherever Jo was.
    const lamp = jo.getByRole('alertdialog')
    await expect(lamp).toContainText('Standby')
    await expect(lamp).toContainText(label)
    expect(await textContrast(jo, '.cue-light-word')).toBeGreaterThan(4.5)
    expect(await textContrast(jo, '.cue-light-ready')).toBeGreaterThan(4.5)
    await lamp.getByRole('button', { name: 'Standing by' }).click()
    await expect(lamp).toContainText('Wait for GO')

    await expect(mine).toContainText(`${joName} is standing by`)
    await mine.getByRole('button', { name: 'GO', exact: true }).click()
    await expect(lamp.getByText('GO', { exact: true })).toBeVisible()
    expect(await textContrast(jo, '.cue-light-word')).toBeGreaterThan(4.5)
    await lamp.getByRole('button', { name: 'Done' }).click()
    await expect(jo.getByRole('alertdialog')).toHaveCount(0)

    // And it is history on the caller's pane.
    await expect(sam.getByRole('heading', { name: 'Earlier' })).toBeVisible()
    await expect(mine).toContainText(/GO at \d\d:\d\d:\d\d · answered in/)
  })
}

test('GO to somebody who has not answered arms first', async ({ browser }) => {
  const joName = uniqueName('Jo')
  await newDevice(browser, joName)
  const sam = await newDevice(browser, uniqueName('Sam'))
  await sam.goto('/m/cues')
  const form = sam.getByRole('form', { name: 'Call a standby' })
  await form.getByLabel('Who').selectOption({ label: joName })
  const label = uniqueName('CO2')
  await form.getByLabel('Cue').fill(label)
  await form.getByRole('button', { name: 'Call standby' }).click()

  const mine = sam.locator('main li', { hasText: label })
  await mine.getByRole('button', { name: 'GO', exact: true }).click()
  const armed = mine.getByRole('button', { name: 'GO without standby?' })
  await expect(armed).toHaveAttribute('data-armed', 'true')
  await armed.click()
  await expect(mine).toContainText(/GO at \d\d:\d\d:\d\d · not answered/)
})

test('a call for help reaches everyone, who can say they are going', async ({ browser }) => {
  const joName = uniqueName('Jo')
  const samName = uniqueName('Sam')
  const jo = await newDevice(browser, joName)
  const sam = await newDevice(browser, samName)

  // A quick press is not a call.
  const hold = jo.getByRole('button', { name: 'Hold for help' })
  await hold.click()
  await expect(sam.locator('.panic-bar')).toHaveCount(0)

  // Two seconds held is.
  await hold.hover()
  await jo.mouse.down()
  await jo.waitForTimeout(2300)
  await jo.mouse.up()
  await expect(jo.locator('.panic-bar')).toContainText('Help is called')

  const bar = sam.locator('.panic-bar')
  await expect(bar).toContainText(`${joName} needs help`)
  await expect(bar).toContainText('Nobody has said they are going yet.')
  await bar.getByRole('button', { name: 'I’m going' }).click()
  await expect(bar).toContainText(`${samName} is on the way.`)
  await expect(jo.locator('.panic-bar')).toContainText(`${samName} is on the way.`)

  // The record is in #general for anyone who missed it.
  await expect(sam.locator('main')).toContainText(`${joName} held the panic button`)

  // Standing it down takes it off every screen, and is armed.
  const ok = jo.locator('.panic-bar').getByRole('button', { name: 'I’m OK' })
  await ok.click()
  await jo.getByRole('button', { name: 'Stand down? Phones stop ringing' }).click()
  await expect(sam.locator('.panic-bar')).toHaveCount(0)
  await expect(sam.locator('main')).toContainText(`${joName} is OK and stood down`)
})
