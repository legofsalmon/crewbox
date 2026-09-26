import { expect, type Page } from '@playwright/test'
import { newDevice, test, uniqueName } from './helpers'

/**
 * Alerts decided on the box (docs/ALERTS.md), through a real box and real
 * pages: a person's settings kept on the box, the alerts that reach the page
 * while it is open, and the alerts socket's signed first frame.
 *
 * What only a phone can show (the lock screen, the sound on silent, the
 * iPhone's provider) is on the phone-test list in docs/ALERTS.md.
 */

const openChannel = async (page: Page, name: string) => {
  await page
    .getByRole('button', { name: new RegExp(`^#?\\s*${name}`) })
    .first()
    .click()
  await expect(page.getByPlaceholder(`Message #${name}`)).toBeVisible()
}

const say = async (page: Page, channel: string, text: string) => {
  const composer = page.getByPlaceholder(`Message #${channel}`)
  await composer.fill(text)
  await composer.press('Enter')
  await expect(page.locator('main').getByText(text)).toBeVisible()
}

test("a channel's level is kept on the box, and follows the person", async ({ browser }) => {
  const page = await newDevice(browser, uniqueName('Bell'))
  await openChannel(page, 'general')
  await page.getByRole('button', { name: 'Alerts for general: Mentions' }).click()
  await page.getByRole('menuitemradio', { name: /Muted/ }).click()
  await expect(page.getByRole('button', { name: 'Alerts for general: Muted' })).toBeVisible()

  // From the box: the welcome carries it back.
  await page.reload()
  await openChannel(page, 'general')
  await expect(page.getByRole('button', { name: 'Alerts for general: Muted' })).toBeVisible()

  // And the settings screen says the same, and sets it back.
  await page.getByRole('button', { name: 'Alerts…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Alerts' })
  await expect(dialog.getByLabel('#general')).toHaveValue('muted')
  await dialog.getByLabel('#general').selectOption('all')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('button', { name: 'Alerts for general: All messages' })).toBeVisible()
})

test('a mention and a show stop reach an open page', async ({ browser }) => {
  const joName = uniqueName('Jo')
  const jo = await newDevice(browser, joName)
  const sam = await newDevice(browser, uniqueName('Sam'))

  // Jo is in a channel of their own, so nothing in #general is on screen.
  const elsewhere = `desk-${Date.now().toString(36)}`
  await jo.getByRole('button', { name: 'New channel' }).click()
  await jo.getByPlaceholder('channel-name').fill(elsewhere)
  await jo.keyboard.press('Enter')
  await jo.getByRole('button', { name: `#${elsewhere}` }).click()
  await expect(jo.getByPlaceholder(`Message #${elsewhere}`)).toBeVisible()

  await openChannel(sam, 'general')
  await say(sam, 'general', `@${joName} the hazer is out`)
  const banner = jo.locator('.alert-banner')
  await expect(banner).toContainText(`in #general`)
  await expect(banner).toContainText('the hazer is out')

  // A show stop, logged now, reaches everyone but its author.
  await sam.goto('/m/incident')
  await sam.getByRole('button', { name: 'Log an entry' }).click()
  await sam.getByLabel('What happened').fill('Wind over the limit')
  await sam.getByLabel('Kind', { exact: true }).selectOption('show-stop')
  await sam.getByLabel('How bad', { exact: true }).selectOption('serious')
  await sam.getByRole('button', { name: 'Log it' }).click()
  await expect(banner).toContainText('Show stop')
  await expect(banner).toContainText('Wind over the limit')
  await expect(sam.locator('.alert-banner')).toHaveCount(0)

  // Tapping it opens the show log.
  await banner.getByRole('button').first().click()
  await expect(jo.getByRole('heading', { name: 'Show log' })).toBeVisible()
})

test('a stage is followed from the running order', async ({ browser }) => {
  const page = await newDevice(browser, uniqueName('Follower'))
  await page.goto('/m/schedule')
  await expect(page.getByRole('heading', { name: 'Running order' })).toBeVisible()
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('button', { name: '+ Add act' }).click()
  const stage = uniqueName('TENT')
  const editor = page.locator('main')
  await editor.getByLabel('Act', { exact: true }).last().fill(uniqueName('OPENER'))
  await editor.getByLabel('Stage', { exact: true }).last().fill(stage)
  await editor.getByLabel('On', { exact: true }).last().fill('21:00')
  await editor.getByLabel('Off', { exact: true }).last().fill('22:00')
  await page.getByRole('button', { name: 'Done' }).click()

  const follow = page.getByRole('button', { name: `Changeover calls for ${stage}` })
  await expect(follow).toHaveAttribute('aria-pressed', 'false')
  await follow.click()
  await expect(follow).toHaveAttribute('aria-pressed', 'true')

  await page.reload()
  await expect(page.getByRole('button', { name: `Changeover calls for ${stage}` })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})

test("the alerts socket's first frame is signed with the event's key", async ({ browser }) => {
  const page = await newDevice(browser)
  const result = await page.evaluate(async () => {
    const b64url = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    const unb64url = (text: string) =>
      Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)))
    const identity = (await (
      await fetch(`/api/identity?nonce=${b64url(crypto.getRandomValues(new Uint8Array(16)))}`)
    ).json()) as { eventId: string; key: string }
    const config = (await (await fetch('/api/config')).json()) as { alerts?: number }
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/alerts?nonce=${nonce}`
    const frame = await new Promise<{ type: string; eventId: string; signature: string }>(
      (resolve, reject) => {
        const ws = new WebSocket(url)
        ws.onmessage = (event) => {
          ws.close()
          resolve(JSON.parse(event.data as string))
        }
        ws.onerror = () => reject(new Error('socket failed'))
      }
    )
    const key = await crypto.subtle.importKey(
      'raw',
      unb64url(identity.key),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    )
    const statement = `crewbox-identity-v1\n${frame.eventId}\n${location.host}\n${nonce}`
    const verify = (text: string) =>
      crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        unb64url(frame.signature),
        new TextEncoder().encode(text)
      )
    return {
      alerts: config.alerts,
      type: frame.type,
      sameEvent: frame.eventId === identity.eventId,
      verifies: await verify(statement),
      anotherHost: await verify(statement.replace(location.host, '10.0.0.9:3000')),
    }
  })
  expect(result).toEqual({
    alerts: 1,
    type: 'box',
    sameEvent: true,
    verifies: true,
    anotherHost: false,
  })
})
