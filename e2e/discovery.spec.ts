import { expect, type Page } from '@playwright/test'
import {
  announce,
  appWithDiscovery,
  discoveryCalls,
  test,
  uniqueName,
  type FoundService,
} from './helpers'

/**
 * Boxes on this Wi-Fi, in the apps.
 *
 * The native search (DiscoveryPlugin, on each phone) is stood in for: it
 * reports what the test says it found, as the real one passes on whatever the
 * network announced. Everything after that is the real app against the real
 * box: picking a box asks it which event it runs, and joining goes to it.
 * What a listing may never do is move an event this phone already holds to
 * another address, so an announcement claiming one elsewhere is not listed.
 */

const BOX = 'http://localhost:4299'

/** The suite's box as it announces itself, under whatever name the test gives it. */
async function suiteBox(name: string): Promise<FoundService> {
  const config = (await (await fetch(`${BOX}/api/config`)).json()) as { eventId: string }
  return {
    name,
    addresses: ['127.0.0.1'],
    port: 4299,
    txt: { txtvers: '1', id: config.eventId, name, setup: '1' },
  }
}

const nearby = (page: Page) => page.getByRole('region', { name: 'Boxes on this Wi-Fi' })

async function joinAs(page: Page, name: string) {
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Event PIN').fill('4242')
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
}

test('the Android app lists the box on this Wi-Fi, and joins it with nothing typed but a name', async ({
  browser,
}) => {
  const page = await appWithDiscovery(browser, 'android', [await suiteBox('Main Stage Crew')])
  await page.goto('/')

  const list = nearby(page)
  await expect(list.getByText('Main Stage Crew')).toBeVisible()
  await expect(list.getByText('127.0.0.1:4299')).toBeVisible()
  await list.getByRole('button', { name: 'Pick Main Stage Crew' }).click()

  // Its address, filled in once the box itself has answered, and on to the name.
  await expect(page.getByLabel('Crew server')).toHaveValue('127.0.0.1:4299')
  await expect(list.getByText('Picked')).toBeVisible()
  await expect(page.getByLabel('Your name')).toBeFocused()
  await joinAs(page, uniqueName('Found Tech'))

  // Nothing on screen is looking any more, so neither is the phone.
  await expect.poll(() => discoveryCalls(page)).toEqual(['start', 'stop'])
})

test('the iPhone app asks before its first search, and looks by itself after that', async ({
  browser,
}) => {
  const page = await appWithDiscovery(browser, 'ios', [await suiteBox('Main Stage Crew')])
  await page.goto('/')

  // iOS asks about the local network once, on the first search: not before
  // the crew member knows why.
  await expect(nearby(page)).toContainText('Your iPhone will ask')
  expect(await discoveryCalls(page)).toEqual([])
  await nearby(page).getByRole('button', { name: 'Find boxes' }).click()
  await expect(nearby(page).getByText('Main Stage Crew')).toBeVisible()

  await page.reload()
  await expect(nearby(page).getByText('Main Stage Crew')).toBeVisible()
  expect(await discoveryCalls(page)).toEqual(['start'])
})

test('the Boxes screen says which box is here, and lists no stand-in for it', async ({
  browser,
}) => {
  const ours = await suiteBox('Main Stage Crew')
  const page = await appWithDiscovery(browser, 'android', [])
  await page.goto('/')
  await page.getByLabel('Crew server').fill('127.0.0.1:4299')
  await joinAs(page, uniqueName('Wi-Fi Tech'))

  await announce(page, [
    ours,
    // Anything on the Wi-Fi can claim this event: listing it would be one tap
    // from sending this phone's work somewhere else.
    { ...ours, name: 'Main Stage Crew (2)', port: 4398 },
    // Another event's box, which has just gone quiet.
    {
      name: 'Quay Stage',
      addresses: ['127.0.0.1'],
      port: 4397,
      txt: { txtvers: '1', id: 'quaystage', name: 'Quay Stage', setup: '1' },
    },
    // A new box nobody has set up.
    {
      name: 'crewbox',
      addresses: ['127.0.0.1'],
      port: 4396,
      txt: { txtvers: '1', id: 'freshbox', setup: '0' },
    },
  ])
  await page.getByRole('button', { name: 'Your boxes', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Your boxes' })
  await expect(dialog.locator('.boxes-row', { hasText: '127.0.0.1:4299' })).toContainText(
    'On this Wi-Fi'
  )

  const list = nearby(page)
  await expect(list.getByText('Quay Stage')).toBeVisible()
  await expect(list.getByText('Main Stage Crew')).toHaveCount(0)
  await expect(list).toContainText('Not set up yet. Open 127.0.0.1:4396/setup in a browser')
  await expect(list.getByRole('button', { name: /No name yet/ })).toHaveCount(0)

  await list.getByRole('button', { name: 'Join Quay Stage' }).click()
  await expect(list.getByText('Nothing answered at 127.0.0.1:4397.')).toBeVisible()
})
