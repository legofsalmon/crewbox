import { spawn, type ChildProcess } from 'node:child_process'
import { expect, test } from '@playwright/test'
import {
  cell,
  commitCell,
  configureSync,
  createSheet,
  newDevice,
  openSheetByName,
  syncChip,
  uniqueName,
} from './helpers'

test('two devices sync through the box with zero configuration', async ({ browser }) => {
  const a = await newDevice(browser)
  const name = uniqueName('Sync Fest')
  await createSheet(a, name)

  // Served by the relay => sync auto-configured to the same origin
  await expect(syncChip(a)).toContainText('Synced')
  await commitCell(a, 'Artist 1', '1', 'Input', 'From A')

  const b = await newDevice(browser)
  await openSheetByName(b, name) // arrived via the synced index
  await expect(cell(b, 'Artist 1', '1', 'Input')).toHaveValue('From A')

  await commitCell(b, 'Artist 1', '2', 'Mic/DI', 'From B')
  await expect(cell(a, 'Artist 1', '2', 'Mic/DI')).toHaveValue('From B')

  await expect(syncChip(a)).toContainText('2 devices')
})

test('presence: name, avatar, and live cell-edit highlight', async ({ browser }) => {
  const a = await newDevice(browser)
  const name = uniqueName('Presence Fest')
  await createSheet(a, name)

  const b = await newDevice(browser)
  await openSheetByName(b, name)
  // Set a display name via the sync dialog (URL/token stay as auto-configured)
  await syncChip(b).click()
  await b.locator('#sync-name').fill('Monitors — Sam')
  await b.getByRole('button', { name: 'Save', exact: true }).click()
  await cell(b, 'Artist 1', '2', 'Input').click()

  await expect(a.locator('[title="Monitors — Sam"]')).toBeVisible()
  await expect(a.locator('input[title="Monitors — Sam is editing this cell"]')).toBeVisible()
})

test('a token-gated relay rejects the wrong token and accepts the right one', async ({
  browser,
}) => {
  const TOKEN_PORT = 4198
  let relay: ChildProcess | undefined
  await new Promise<void>((resolve, reject) => {
    relay = spawn('node', ['server/index.cjs'], {
      env: {
        ...process.env,
        PORT: String(TOKEN_PORT),
        LIVEPATCH_TOKEN: 'right-token',
        STATIC_DIR: '',
      },
      stdio: 'ignore',
    })
    relay.on('error', reject)
    const poll = setInterval(() => {
      fetch(`http://localhost:${TOKEN_PORT}/healthz`)
        .then(() => {
          clearInterval(poll)
          resolve()
        })
        .catch(() => {})
    }, 200)
  })

  try {
    const page = await newDevice(browser)
    await createSheet(page, uniqueName('Token Fest'))

    await configureSync(page, `ws://localhost:${TOKEN_PORT}`, 'wrong-token')
    await expect(syncChip(page)).toContainText('Connecting…')
    await page.waitForTimeout(1500)
    await expect(syncChip(page)).not.toContainText('Synced')

    await configureSync(page, `ws://localhost:${TOKEN_PORT}`, 'right-token')
    await expect(syncChip(page)).toContainText('Synced')
  } finally {
    relay?.kill()
  }
})
